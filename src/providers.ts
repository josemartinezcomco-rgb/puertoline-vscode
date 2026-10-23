import * as vscode from 'vscode';

export interface ProviderPreset {
  label: string;
  baseUrl: string;
  /** 'ollama' uses Ollama's native API (lets us set the context window); others are OpenAI-compatible. */
  api: 'openai' | 'ollama';
  needsKey: boolean;
  keyUrl?: string;
  note: string;
}

export const PROVIDERS: Record<string, ProviderPreset> = {
  ollama: {
    label: 'Ollama (local)',
    baseUrl: 'http://localhost:11434',
    api: 'ollama',
    needsKey: false,
    note: 'Gratis e ilimitado, corre en tu PC',
  },
  openrouter: {
    label: 'OpenRouter',
    baseUrl: 'https://openrouter.ai/api/v1',
    api: 'openai',
    needsKey: true,
    keyUrl: 'https://openrouter.ai/keys',
    note: 'Modelos ":free" gratuitos con límite diario',
  },
  gemini: {
    label: 'Google Gemini',
    baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai',
    api: 'openai',
    needsKey: true,
    keyUrl: 'https://aistudio.google.com/apikey',
    note: 'Plan gratuito con límite por minuto/día',
  },
  groq: {
    label: 'Groq',
    baseUrl: 'https://api.groq.com/openai/v1',
    api: 'openai',
    needsKey: true,
    keyUrl: 'https://console.groq.com/keys',
    note: 'Plan gratuito, muy rápido',
  },
  cerebras: {
    label: 'Cerebras',
    baseUrl: 'https://api.cerebras.ai/v1',
    api: 'openai',
    needsKey: true,
    keyUrl: 'https://cloud.cerebras.ai',
    note: 'Plan gratuito, muy rápido',
  },
  mistral: {
    label: 'Mistral',
    baseUrl: 'https://api.mistral.ai/v1',
    api: 'openai',
    needsKey: true,
    keyUrl: 'https://console.mistral.ai/api-keys',
    note: 'Plan gratuito "Experiment"',
  },
  github: {
    label: 'GitHub Models',
    baseUrl: 'https://models.github.ai/inference',
    api: 'openai',
    needsKey: true,
    keyUrl: 'https://github.com/settings/tokens',
    note: 'Gratis con tu cuenta de GitHub (token con permiso models:read)',
  },
  deepseek: {
    label: 'DeepSeek',
    baseUrl: 'https://api.deepseek.com/v1',
    api: 'openai',
    needsKey: true,
    keyUrl: 'https://platform.deepseek.com/api_keys',
    note: 'De pago (muy barato)',
  },
  custom: {
    label: 'Personalizado (compatible con OpenAI)',
    baseUrl: '',
    api: 'openai',
    needsKey: false,
    note: 'LM Studio, vLLM, OpenAI, etc. Requiere "baseUrl" en la entrada',
  },
};

export interface ModelEntry {
  provider: string;
  /** Model id. "*" = every model the provider lists; "*free*" = every free tool-capable model (OpenRouter). */
  model: string;
  baseUrl?: string;
  /** Secret name for providers that need a key but aren't presets (custom). Defaults to the provider id. */
  keyName?: string;
  disabled?: boolean;
}

export interface ResolvedModel {
  /** Unique id used for cooldown tracking and display: provider/model. */
  id: string;
  provider: string;
  model: string;
  baseUrl: string;
  apiKey: string;
  api: 'openai' | 'ollama';
  local: boolean;
  /** Index of the configured entry it came from; the router only reorders within a group. */
  group: number;
}

export function secretName(provider: string): string {
  return `puertoline.apiKey.${provider}`;
}

export async function getApiKey(secrets: vscode.SecretStorage, provider: string): Promise<string | undefined> {
  return secrets.get(secretName(provider));
}

const WILDCARD_LIMIT = 12;
const listCache = new Map<string, { at: number; models: string[] }>();

/** Lists models a provider offers. For OpenRouter, only tool-capable ones (and only free ones when freeOnly). */
export async function listModels(
  provider: string,
  baseUrl: string,
  apiKey: string,
  freeOnly = false
): Promise<string[]> {
  const cacheKey = `${provider}|${baseUrl}|${freeOnly}`;
  const cached = listCache.get(cacheKey);
  if (cached && Date.now() - cached.at < 10 * 60_000) return cached.models;

  const signal = AbortSignal.timeout(10_000);
  let models: string[];
  if (PROVIDERS[provider]?.api === 'ollama') {
    const res = await fetch(`${baseUrl.replace(/\/+$/, '')}/api/tags`, { signal });
    if (!res.ok) throw new Error(`Ollama respondió HTTP ${res.status}`);
    const data: any = await res.json();
    models = (data.models ?? []).map((m: any) => m.name as string).filter((n: string) => !/embed/i.test(n));
  } else {
    const res = await fetch(`${baseUrl.replace(/\/+$/, '')}/models`, {
      signal,
      headers: apiKey ? { Authorization: `Bearer ${apiKey}` } : {},
    });
    if (!res.ok) throw new Error(`HTTP ${res.status} al listar modelos`);
    const data: any = await res.json();
    let items: any[] = Array.isArray(data) ? data : data.data ?? data.models ?? [];
    if (provider === 'openrouter') {
      items = items.filter((m) => (m.supported_parameters ?? []).includes('tools'));
      if (freeOnly) items = items.filter((m) => String(m.id).endsWith(':free'));
      items.sort((a, b) => (b.context_length ?? 0) - (a.context_length ?? 0));
    }
    models = items
      .map((m) => String(m.id ?? m.name ?? '').replace(/^models\//, ''))
      .filter((id) => id && !/embed|whisper|tts|audio|image|imagen|veo|guard|moderation|transcribe/i.test(id));
  }
  listCache.set(cacheKey, { at: Date.now(), models });
  return models;
}

/**
 * Turns the configured chain into concrete models, in order. Entries whose provider needs a key that
 * isn't set are skipped; wildcards are expanded by asking the provider.
 */
export async function resolveChain(
  secrets: vscode.SecretStorage,
  log: (msg: string) => void
): Promise<ResolvedModel[]> {
  const entries = vscode.workspace.getConfiguration('puertoline').get<ModelEntry[]>('models') ?? [];
  const out: ResolvedModel[] = [];
  const seen = new Set<string>();

  for (const [group, entry] of entries.entries()) {
    if (entry.disabled) continue;
    const preset = PROVIDERS[entry.provider];
    if (!preset) {
      log(`Proveedor desconocido "${entry.provider}"`);
      continue;
    }
    const baseUrl = entry.baseUrl || preset.baseUrl;
    if (!baseUrl) {
      log(`La entrada ${entry.provider}/${entry.model} necesita "baseUrl"`);
      continue;
    }
    const apiKey = (await getApiKey(secrets, entry.keyName || entry.provider)) ?? '';
    if (preset.needsKey && !apiKey) continue;

    let models = [entry.model];
    if (entry.model === '*' || entry.model === '*free*') {
      try {
        models = (await listModels(entry.provider, baseUrl, apiKey, entry.model === '*free*')).slice(0, WILDCARD_LIMIT);
      } catch (e: any) {
        log(`No se pudieron listar los modelos de ${preset.label}: ${e?.message ?? e}`);
        models = [];
      }
    }
    for (const model of models) {
      const id = `${entry.provider}/${model}`;
      if (seen.has(id)) continue;
      seen.add(id);
      out.push({ id, provider: entry.provider, model, baseUrl, apiKey, api: preset.api, local: entry.provider === 'ollama', group });
    }
  }
  return out;
}
