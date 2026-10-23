// Streaming chat clients: OpenAI-compatible APIs (DeepSeek, OpenRouter, Groq, Gemini...) and Ollama's native API.
import type { ResolvedModel } from './providers';

export interface ToolCall {
  id: string;
  type: 'function';
  function: { name: string; arguments: string };
}

export type ChatMessage =
  | { role: 'system' | 'user'; content: string }
  | { role: 'assistant'; content: string | null; tool_calls?: ToolCall[] }
  | { role: 'tool'; tool_call_id: string; content: string };

export interface ToolSpec {
  type: 'function';
  function: { name: string; description: string; parameters: object };
}

export interface StreamHandlers {
  onText(delta: string): void;
  onReasoning?(delta: string): void;
}

export interface CompletionResult {
  content: string;
  reasoning: string;
  toolCalls: ToolCall[];
  finishReason: string | null;
}

export interface StreamOptions {
  /** Max wait for the first byte of output. */
  firstTokenMs: number;
  /** Max silence between chunks once streaming. */
  idleMs: number;
  /** Ollama only: context window (num_ctx). */
  contextLength?: number;
}

export class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly body: string,
    readonly retryAfterSec?: number
  ) {
    super(`HTTP ${status}: ${body.slice(0, 300)}`);
  }
}

export class TimeoutError extends Error {}

/** Mistral requires 9-char alphanumeric ids; every other provider accepts them too. */
function newCallId(): string {
  const chars = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
  let id = '';
  for (let i = 0; i < 9; i++) id += chars[Math.floor(Math.random() * chars.length)];
  return id;
}

export async function streamChat(
  model: ResolvedModel,
  messages: ChatMessage[],
  tools: ToolSpec[],
  handlers: StreamHandlers,
  signal: AbortSignal,
  opts: StreamOptions
): Promise<CompletionResult> {
  // Our own controller lets timeouts abort the request without being confused with a user "stop".
  const ctrl = new AbortController();
  const onUserAbort = () => ctrl.abort();
  signal.addEventListener('abort', onUserAbort, { once: true });
  let timedOut: string | undefined;
  let timer: NodeJS.Timeout | undefined;
  const arm = (ms: number, what: string) => {
    clearTimeout(timer);
    timer = setTimeout(() => {
      timedOut = what;
      ctrl.abort();
    }, ms);
  };

  arm(opts.firstTokenMs, `sin respuesta tras ${Math.round(opts.firstTokenMs / 1000)}s`);
  try {
    const lines = model.api === 'ollama' ? ollamaRequest(model, messages, tools, ctrl.signal, opts) : openaiRequest(model, messages, tools, ctrl.signal);
    const result = model.api === 'ollama' ? await parseOllama(lines, handlers, () => arm(opts.idleMs, 'el stream se detuvo')) : await parseOpenAI(lines, handlers, () => arm(opts.idleMs, 'el stream se detuvo'));
    result.toolCalls = result.toolCalls.filter((c) => c.function.name).map((c) => ({ ...c, id: newCallId() }));
    if (!result.toolCalls.length) {
      const recovered = recoverTextToolCall(result.content, new Set(tools.map((t) => t.function.name)));
      if (recovered) {
        result.content = recovered.before;
        result.toolCalls = [{ id: newCallId(), type: 'function', function: recovered.call }];
      }
    }
    return result;
  } catch (e) {
    if (timedOut && !signal.aborted) throw new TimeoutError(timedOut);
    throw e;
  } finally {
    clearTimeout(timer);
    signal.removeEventListener('abort', onUserAbort);
  }
}

/** Yields every top-level {...} JSON object embedded in free text, with its start offset. */
function* jsonObjects(text: string): Generator<{ value: any; start: number }> {
  for (let start = text.indexOf('{'); start >= 0; start = text.indexOf('{', start + 1)) {
    let depth = 0;
    let inString = false;
    for (let i = start; i < text.length; i++) {
      const ch = text[i];
      if (inString) {
        if (ch === '\\') i++;
        else if (ch === '"') inString = false;
      } else if (ch === '"') inString = true;
      else if (ch === '{') depth++;
      else if (ch === '}' && --depth === 0) {
        try {
          yield { value: JSON.parse(text.slice(start, i + 1)), start };
          start = i;
        } catch {
          /* not JSON, keep scanning */
        }
        break;
      }
    }
  }
}

/**
 * Small local models often write the tool call as JSON text (sometimes inside ```json or <tool_call>)
 * instead of using native tool calling. Recover only the FIRST call: whatever follows is usually the
 * model guessing at results it hasn't seen yet.
 */
function recoverTextToolCall(
  content: string,
  toolNames: Set<string>
): { before: string; call: { name: string; arguments: string } } | undefined {
  for (const { value, start } of jsonObjects(content)) {
    const name = value?.name ?? value?.function?.name ?? value?.tool;
    if (typeof name !== 'string' || !toolNames.has(name)) continue;
    const args = value.arguments ?? value.parameters ?? value.function?.arguments ?? value.args ?? {};
    const before = content
      .slice(0, start)
      .replace(/```(json)?\s*$/i, '')
      .replace(/<tool_call>\s*$/i, '')
      .trim();
    return { before, call: { name, arguments: typeof args === 'string' ? args : JSON.stringify(args) } };
  }
  return undefined;
}

async function checkResponse(res: Response): Promise<ReadableStream<Uint8Array>> {
  if (!res.ok || !res.body) {
    const text = await res.text().catch(() => '');
    const ra = Number(res.headers.get('retry-after'));
    throw new HttpError(res.status, text || res.statusText, Number.isFinite(ra) && ra > 0 ? ra : undefined);
  }
  return res.body;
}

async function* readLines(body: Promise<ReadableStream<Uint8Array>>): AsyncGenerator<string> {
  const reader = (await body).getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let nl: number;
    while ((nl = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, nl).trim();
      buffer = buffer.slice(nl + 1);
      if (line) yield line;
    }
  }
  if (buffer.trim()) yield buffer.trim();
}

// ---------- OpenAI-compatible ----------

function openaiRequest(model: ResolvedModel, messages: ChatMessage[], tools: ToolSpec[], signal: AbortSignal): AsyncGenerator<string> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (model.apiKey) headers.Authorization = `Bearer ${model.apiKey}`;
  if (model.provider === 'openrouter') {
    headers['HTTP-Referer'] = 'https://github.com/josemartinezcomco-rgb/puertoline-vscode';
    headers['X-Title'] = 'Puertoline';
  }
  const res = fetch(model.baseUrl.replace(/\/+$/, '') + '/chat/completions', {
    method: 'POST',
    signal,
    headers,
    body: JSON.stringify({ model: model.model, messages, tools, tool_choice: 'auto', stream: true }),
  });
  return readLines(res.then(checkResponse));
}

async function parseOpenAI(lines: AsyncGenerator<string>, handlers: StreamHandlers, onChunk: () => void): Promise<CompletionResult> {
  let content = '';
  let reasoning = '';
  let finishReason: string | null = null;
  const calls: ToolCall[] = [];

  for await (const line of lines) {
    onChunk();
    if (!line.startsWith('data:')) continue;
    const data = line.slice(5).trim();
    if (data === '[DONE]') continue;
    let chunk: any;
    try {
      chunk = JSON.parse(data);
    } catch {
      continue;
    }
    // Some providers (OpenRouter) report upstream failures inside a 200 stream.
    if (chunk.error) throw new HttpError(Number(chunk.error.code) || 502, chunk.error.message ?? JSON.stringify(chunk.error));
    const choice = chunk.choices?.[0];
    if (!choice) continue;
    const delta = choice.delta ?? {};

    const think = delta.reasoning_content ?? delta.reasoning;
    if (think) {
      reasoning += think;
      handlers.onReasoning?.(think);
    }
    if (delta.content) {
      content += delta.content;
      handlers.onText(delta.content);
    }
    for (const tc of delta.tool_calls ?? []) {
      let i: number = tc.index ?? -1;
      if (i < 0) {
        // No index (some servers): a new id starts a new call, otherwise continue the last one.
        const last = calls[calls.length - 1];
        i = !last || (tc.id && last.id && tc.id !== last.id) ? calls.length : calls.length - 1;
      }
      calls[i] ??= { id: '', type: 'function', function: { name: '', arguments: '' } };
      if (tc.id) calls[i].id = tc.id;
      if (tc.function?.name) calls[i].function.name += tc.function.name;
      if (tc.function?.arguments) {
        calls[i].function.arguments += typeof tc.function.arguments === 'string' ? tc.function.arguments : JSON.stringify(tc.function.arguments);
      }
    }
    if (choice.finish_reason) finishReason = choice.finish_reason;
  }
  return { content, reasoning, toolCalls: calls.filter(Boolean), finishReason };
}

// ---------- Ollama native (/api/chat) ----------

function toOllamaMessages(messages: ChatMessage[]): object[] {
  const names = new Map<string, string>();
  return messages.map((m) => {
    if (m.role === 'assistant') {
      return {
        role: 'assistant',
        content: m.content ?? '',
        tool_calls: m.tool_calls?.map((c) => {
          names.set(c.id, c.function.name);
          let args: unknown = {};
          try {
            args = JSON.parse(c.function.arguments || '{}');
          } catch {
            /* keep {} */
          }
          return { function: { name: c.function.name, arguments: args } };
        }),
      };
    }
    if (m.role === 'tool') return { role: 'tool', content: m.content, tool_name: names.get(m.tool_call_id) };
    return m;
  });
}

function ollamaRequest(
  model: ResolvedModel,
  messages: ChatMessage[],
  tools: ToolSpec[],
  signal: AbortSignal,
  opts: StreamOptions
): AsyncGenerator<string> {
  const res = fetch(model.baseUrl.replace(/\/+$/, '').replace(/\/v1$/, '') + '/api/chat', {
    method: 'POST',
    signal,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: model.model,
      messages: toOllamaMessages(messages),
      tools,
      stream: true,
      options: { num_ctx: opts.contextLength ?? 32768 },
    }),
  });
  return readLines(res.then(checkResponse));
}

async function parseOllama(lines: AsyncGenerator<string>, handlers: StreamHandlers, onChunk: () => void): Promise<CompletionResult> {
  let content = '';
  let reasoning = '';
  let finishReason: string | null = null;
  const calls: ToolCall[] = [];

  for await (const line of lines) {
    onChunk();
    let chunk: any;
    try {
      chunk = JSON.parse(line);
    } catch {
      continue;
    }
    if (chunk.error) throw new HttpError(500, String(chunk.error));
    const msg = chunk.message ?? {};
    if (msg.thinking) {
      reasoning += msg.thinking;
      handlers.onReasoning?.(msg.thinking);
    }
    if (msg.content) {
      content += msg.content;
      handlers.onText(msg.content);
    }
    for (const tc of msg.tool_calls ?? []) {
      const args = tc.function?.arguments;
      calls.push({
        id: '',
        type: 'function',
        function: { name: tc.function?.name ?? '', arguments: typeof args === 'string' ? args : JSON.stringify(args ?? {}) },
      });
    }
    if (chunk.done) finishReason = chunk.done_reason ?? 'stop';
  }
  return { content, reasoning, toolCalls: calls, finishReason };
}
