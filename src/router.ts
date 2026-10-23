import * as vscode from 'vscode';
import { ChatMessage, CompletionResult, HttpError, StreamHandlers, TimeoutError, ToolSpec, streamChat } from './llm';
import { ResolvedModel, resolveChain } from './providers';

export interface RouterEvents {
  /** A model is about to be tried. */
  onAttempt(model: ResolvedModel): void;
  /** The attempt failed; any partial output it streamed must be discarded. */
  onFallback(model: ResolvedModel, reason: string, next: ResolvedModel | undefined): void;
  onWait(seconds: number, reason: string): void;
}

interface Cooldown {
  until: number;
  reason: string;
}

interface ModelStats {
  ok: number;
  fail: number;
}

const MAX_ROUNDS = 4;
const MAX_WAIT_SEC = 60;
/** Cooldowns at least this long survive restarts (bad key, no access, model gone). */
const PERSIST_COOLDOWN_SEC = 3600;
const COOLDOWNS_KEY = 'puertoline.cooldowns';
const STATS_KEY = 'puertoline.modelStats';

/**
 * Picks a model for each request, walking the configured chain in order and skipping models that
 * recently failed. Failures put the model on cooldown (longer for rate limits / auth / unsupported),
 * so the primary model is retried automatically once it recovers. Within a wildcard group (e.g.
 * "openrouter/*free*") models that have answered well before are tried first, and long cooldowns
 * and success stats are remembered across sessions.
 */
export class ModelRouter {
  private cooldowns = new Map<string, Cooldown>();
  private stats: Record<string, ModelStats>;
  current?: ResolvedModel;

  constructor(
    private readonly secrets: vscode.SecretStorage,
    private readonly log: (msg: string) => void,
    private readonly memento?: vscode.Memento
  ) {
    const saved = memento?.get<Record<string, Cooldown>>(COOLDOWNS_KEY) ?? {};
    for (const [id, c] of Object.entries(saved)) if (c.until > Date.now()) this.cooldowns.set(id, c);
    this.stats = memento?.get<Record<string, ModelStats>>(STATS_KEY) ?? {};
  }

  status(): Map<string, Cooldown> {
    const now = Date.now();
    for (const [id, c] of this.cooldowns) if (c.until <= now) this.cooldowns.delete(id);
    return this.cooldowns;
  }

  resetCooldowns(): void {
    this.cooldowns.clear();
    void this.memento?.update(COOLDOWNS_KEY, {});
  }

  private record(model: ResolvedModel, ok: boolean, cooldown?: Cooldown): void {
    const s = (this.stats[model.id] ??= { ok: 0, fail: 0 });
    if (ok) s.ok++;
    else s.fail++;
    void this.memento?.update(STATS_KEY, this.stats);
    if (cooldown) {
      this.cooldowns.set(model.id, cooldown);
      if (cooldown.until - Date.now() >= PERSIST_COOLDOWN_SEC * 1000) {
        const persisted = Object.fromEntries([...this.status()].filter(([, c]) => c.until - Date.now() >= 5 * 60_000));
        void this.memento?.update(COOLDOWNS_KEY, persisted);
      }
    }
  }

  private score(id: string): number {
    const s = this.stats[id];
    return s ? s.ok * 2 - s.fail : 0;
  }

  /** Keeps the configured order between entries, but ranks models inside each entry by past success. */
  private rank(models: ResolvedModel[]): ResolvedModel[] {
    return models
      .map((m, i) => ({ m, i }))
      .sort((a, b) => a.m.group - b.m.group || this.score(b.m.id) - this.score(a.m.id) || a.i - b.i)
      .map((x) => x.m);
  }

  async complete(
    messages: ChatMessage[],
    tools: ToolSpec[],
    handlers: StreamHandlers,
    signal: AbortSignal,
    events: RouterEvents
  ): Promise<CompletionResult & { model: ResolvedModel }> {
    const cfg = vscode.workspace.getConfiguration('puertoline');
    const timeoutSec = cfg.get<number>('timeoutSeconds') ?? 90;
    const localTimeoutSec = cfg.get<number>('localTimeoutSeconds') ?? 300;
    const contextLength = cfg.get<number>('ollamaContextLength') ?? 32768;
    const errors: string[] = [];

    for (let round = 0; round < MAX_ROUNDS; round++) {
      const chain = await resolveChain(this.secrets, this.log);
      if (!chain.length) {
        throw new Error(
          'No hay ningún modelo disponible. Configura una API key (🔑) o descarga un modelo de Ollama (botón de modelo → "Descargar modelo de Ollama").'
        );
      }
      const available = this.rank(chain.filter((m) => !this.isCooling(m.id)));

      if (!available.length) {
        const soonest = Math.min(...chain.map((m) => this.cooldowns.get(m.id)?.until ?? Date.now()));
        const wait = Math.max(3, Math.min(MAX_WAIT_SEC, Math.ceil((soonest - Date.now()) / 1000)));
        events.onWait(wait, 'Todos los modelos están ocupados o con límite de uso');
        await sleep(wait * 1000, signal);
        // Give transient failures (rate limits, timeouts) another chance; keep long ones (bad key, 404).
        for (const [id, c] of this.cooldowns) if (c.until - Date.now() < 5 * 60_000) this.cooldowns.delete(id);
        continue;
      }

      for (let i = 0; i < available.length; i++) {
        const model = available[i];
        this.current = model;
        events.onAttempt(model);
        try {
          const result = await streamChat(model, messages, tools, handlers, signal, {
            firstTokenMs: (model.local ? localTimeoutSec : timeoutSec) * 1000,
            idleMs: (model.local ? localTimeoutSec : timeoutSec) * 1000,
            contextLength,
          });
          if (!result.content.trim() && !result.toolCalls.length) {
            throw new EmptyResponse('respuesta vacía');
          }
          this.record(model, true);
          return { ...result, model };
        } catch (e: any) {
          if (signal.aborted) throw e;
          const { reason, cooldownSec } = classify(e);
          this.record(model, false, { until: Date.now() + cooldownSec * 1000, reason });
          errors.push(`${model.id}: ${reason}`);
          this.log(`[modelos] ${model.id} falló: ${reason} (en pausa ${cooldownSec}s)`);
          events.onFallback(model, reason, available[i + 1]);
        }
      }
    }
    throw new Error(`Ningún modelo pudo responder tras ${MAX_ROUNDS} rondas:\n${errors.slice(-8).join('\n')}`);
  }

  private isCooling(id: string): boolean {
    const c = this.cooldowns.get(id);
    return !!c && c.until > Date.now();
  }
}

class EmptyResponse extends Error {}

function classify(e: any): { reason: string; cooldownSec: number } {
  if (e instanceof TimeoutError) return { reason: `timeout (${e.message})`, cooldownSec: 120 };
  if (e instanceof EmptyResponse) return { reason: e.message, cooldownSec: 60 };
  if (e instanceof HttpError) {
    const body = e.body.toLowerCase();
    if (e.status === 429) return { reason: 'límite de uso alcanzado (429)', cooldownSec: Math.max(e.retryAfterSec ?? 0, 90) };
    const detail = providerMessage(e.body);
    if (e.status === 401) return { reason: `API key inválida (401)${detail}`, cooldownSec: 3600 };
    // 403 is usually per-model (data policy, region, moderation), not a bad key.
    if (e.status === 403) return { reason: `sin acceso a este modelo (403)${detail}`, cooldownSec: 3600 };
    if (e.status === 402) return { reason: `sin saldo/créditos (402)${detail}`, cooldownSec: 3600 };
    if (e.status === 404) return { reason: `modelo no disponible (404)${detail}`, cooldownSec: 3600 };
    if (/tool|function/.test(body) && /support|not available|invalid/.test(body)) {
      return { reason: 'el modelo no soporta herramientas', cooldownSec: 3600 };
    }
    if (/context|too long|maximum.*tokens|token limit/.test(body)) {
      return { reason: 'la conversación excede el contexto del modelo', cooldownSec: 600 };
    }
    if (e.status === 400 || e.status === 422) return { reason: `petición rechazada (${e.status}): ${e.body.slice(0, 120)}`, cooldownSec: 600 };
    return { reason: `error del servidor (${e.status})`, cooldownSec: 60 };
  }
  const msg = String(e?.cause?.code ?? e?.message ?? e);
  if (/ECONNREFUSED/.test(msg)) return { reason: 'servicio no disponible (¿Ollama apagado?)', cooldownSec: 120 };
  return { reason: `error de red: ${msg.slice(0, 120)}`, cooldownSec: 60 };
}

/** Pulls the human-readable message out of a provider's JSON error body. */
function providerMessage(body: string): string {
  let msg = body;
  try {
    const j = JSON.parse(body);
    msg = j.error?.metadata?.raw ?? j.error?.message ?? j.message ?? j.error ?? body;
    if (typeof msg !== 'string') msg = JSON.stringify(msg);
  } catch {
    /* plain text body */
  }
  msg = msg.replace(/\s+/g, ' ').trim();
  return msg ? `: ${msg.slice(0, 160)}` : '';
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) return reject(new DOMException('Aborted', 'AbortError'));
    const t = setTimeout(done, ms);
    function done() {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }
    function onAbort() {
      clearTimeout(t);
      reject(new DOMException('Aborted', 'AbortError'));
    }
    signal.addEventListener('abort', onAbort, { once: true });
  });
}
