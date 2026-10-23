import * as vscode from 'vscode';
import * as os from 'os';
import { ChatMessage } from './llm';
import { ModelRouter } from './router';
import { TOOL_SPECS, ToolContext, runTool } from './tools';
import { McpManager } from './mcp';
import { SkillRegistry } from './skills';

export type UiEvent =
  | { type: 'assistantStart' }
  | { type: 'text'; delta: string }
  | { type: 'reasoning'; delta: string }
  | { type: 'tool'; id: string; name: string; args: string }
  | { type: 'toolResult'; id: string; result: string; error: boolean }
  | { type: 'model'; id: string }
  | { type: 'discard' }
  | { type: 'notice'; message: string }
  | { type: 'done' }
  | { type: 'error'; message: string };

const MEMORY_FILES = ['AGENTS.md', 'CLAUDE.md', 'PUERTOLINE.md'];

async function systemPrompt(root: vscode.Uri, mcp: McpManager, skills: SkillRegistry): Promise<string> {
  const catalogue = await skills.catalogue();
  const skillSection = catalogue
    ? `\n\nSkills disponibles (cárgalas con use_skill cuando la tarea encaje; síguelas al pie de la letra):${catalogue}
Las skills pueden mencionar herramientas de otros agentes (Bash, Read, Task, subagentes, TodoWrite…): usa el equivalente que tengas (run_command, read_file, una lista de pasos en tu respuesta) o hazlo tú mismo de forma secuencial.`
    : '';
  const servers = mcp.status().filter((s) => s.state === 'connected');
  const integrations = servers.length
    ? `\n- Servidores MCP conectados (sus herramientas empiezan por mcp__<servidor>__): ${servers.map((s) => `${s.name} (${s.tools.length} herramientas)`).join(', ')}`
    : '\n- No hay servidores MCP conectados.';
  const editor = vscode.window.activeTextEditor;
  const active = editor ? vscode.workspace.asRelativePath(editor.document.uri, false) : 'ninguno';
  const selection =
    editor && !editor.selection.isEmpty
      ? `\nTexto seleccionado por el usuario en ${active}:\n\`\`\`\n${editor.document.getText(editor.selection).slice(0, 4000)}\n\`\`\``
      : '';

  let memory = '';
  for (const name of MEMORY_FILES) {
    try {
      const bytes = await vscode.workspace.fs.readFile(vscode.Uri.joinPath(root, name));
      memory += `\n\n# Instrucciones del proyecto (${name})\n${new TextDecoder().decode(bytes).slice(0, 8000)}`;
    } catch {
      /* not present */
    }
  }

  return `Eres Puertoline, un agente experto en programación, diseño, marketing digital y creación de contenido que trabaja dentro de VS Code sobre el proyecto del usuario.
Puedes explorar, leer, crear y editar archivos y ejecutar comandos con las herramientas disponibles.

Forma de trabajar:
- Antes de modificar código, explora y lee los archivos relevantes. Nunca edites un archivo que no has leído.
- Prefiere edit_file para cambios puntuales; write_file solo para archivos nuevos o reescrituras completas.
- Sigue el estilo, nombres y convenciones del código existente.
- Tras cambiar código, verifica cuando sea posible (compilar, tests, ejecutar) con run_command.
- Si una herramienta falla, lee el error y corrige el enfoque; no repitas la misma llamada.
- Si el usuario rechaza un cambio, detente y pregunta.
- Para integrarte con servicios externos usa las herramientas MCP disponibles; si no hay una adecuada, usa http_request contra su API.
- Responde en el idioma del usuario, de forma concisa, en Markdown. Al terminar, resume qué cambiaste.

Entorno:
- Raíz del proyecto: ${root.fsPath}
- Sistema: ${os.platform()} ${os.release()} (los comandos se ejecutan en ${process.platform === 'win32' ? 'PowerShell' : 'bash'})
- Fecha: ${new Date().toISOString().slice(0, 10)}
- Archivo abierto en el editor: ${active}${integrations}${selection}${skillSection}${memory}`;
}

export class Agent {
  private history: ChatMessage[] = [];
  private abort?: AbortController;

  constructor(
    private readonly router: ModelRouter,
    private readonly makeToolContext: (signal: AbortSignal) => ToolContext
  ) {}

  get busy(): boolean {
    return !!this.abort;
  }

  reset(): void {
    this.stop();
    this.history = [];
  }

  stop(): void {
    this.abort?.abort();
    this.abort = undefined;
  }

  async send(text: string, emit: (e: UiEvent) => void): Promise<void> {
    const cfg = vscode.workspace.getConfiguration('puertoline');
    const folder = vscode.workspace.workspaceFolders?.[0];
    if (!folder) {
      emit({ type: 'error', message: 'Abre una carpeta de proyecto en VS Code primero (Archivo → Abrir carpeta).' });
      return;
    }

    const abort = new AbortController();
    this.abort = abort;
    const ctx = this.makeToolContext(abort.signal);
    const maxSteps = cfg.get<number>('maxSteps') ?? 40;

    try {
      this.history.push({ role: 'user', content: await this.expandSkillInvocation(text, ctx) });
      await ctx.mcp.ready();
      for (let step = 0; step < maxSteps; step++) {
        const messages: ChatMessage[] = [{ role: 'system', content: await systemPrompt(folder.uri, ctx.mcp, ctx.skills) }, ...this.history];
        emit({ type: 'assistantStart' });
        const result = await this.router.complete(
          messages,
          [...TOOL_SPECS, ...ctx.mcp.toolSpecs()],
          {
            onText: (delta) => emit({ type: 'text', delta }),
            onReasoning: (delta) => emit({ type: 'reasoning', delta }),
          },
          abort.signal,
          {
            onAttempt: (m) => emit({ type: 'model', id: m.id }),
            onFallback: (m, reason, next) => {
              emit({ type: 'discard' });
              emit({ type: 'notice', message: `⚠ ${m.id}: ${reason}${next ? ` → probando ${next.id}` : ''}` });
            },
            onWait: (sec, reason) => emit({ type: 'notice', message: `⏳ ${reason}. Reintentando en ${sec}s…` }),
          }
        );

        this.history.push({
          role: 'assistant',
          content: result.content || null,
          ...(result.toolCalls.length ? { tool_calls: result.toolCalls } : {}),
        });

        if (!result.toolCalls.length) break;

        for (const call of result.toolCalls) {
          emit({ type: 'tool', id: call.id, name: call.function.name, args: call.function.arguments });
          let output: string;
          let error = false;
          try {
            const args = call.function.arguments ? JSON.parse(call.function.arguments) : {};
            output = await runTool(call.function.name, args, ctx);
          } catch (e: any) {
            error = true;
            output = `Error: ${e?.message ?? String(e)}`;
          }
          emit({ type: 'toolResult', id: call.id, result: output, error });
          this.history.push({ role: 'tool', tool_call_id: call.id, content: output });
          if (abort.signal.aborted) throw new DOMException('Aborted', 'AbortError');
        }

        if (step === maxSteps - 1) {
          emit({ type: 'error', message: `Se alcanzó el máximo de ${maxSteps} pasos. Escribe "continúa" para seguir.` });
        }
      }
    } catch (e: any) {
      if (e?.name === 'AbortError') {
        emit({ type: 'error', message: 'Detenido por el usuario.' });
      } else {
        emit({ type: 'error', message: e?.message ?? String(e) });
      }
      this.repairHistory();
    } finally {
      if (this.abort === abort) this.abort = undefined;
      emit({ type: 'done' });
    }
  }

  /** "/skill-name task" preloads that skill's instructions into the user message. */
  private async expandSkillInvocation(text: string, ctx: ToolContext): Promise<string> {
    const m = text.match(/^\/([\w.-]+)\s*([\s\S]*)$/);
    if (!m || !(await ctx.skills.get(m[1]))) return text;
    const body = await ctx.skills.read(m[1]);
    return `${m[2] || '(sin más indicaciones: pregúntame lo que necesites)'}\n\n[He invocado la skill "${m[1]}". Sigue estas instrucciones para esta tarea:]\n\n${body}`;
  }

  /** After an interruption, make sure every tool call has a matching tool result so the API accepts the history. */
  private repairHistory(): void {
    const last = [...this.history].reverse().find((m) => m.role === 'assistant');
    if (!last || last.role !== 'assistant' || !last.tool_calls) return;
    const answered = new Set(this.history.filter((m) => m.role === 'tool').map((m) => (m as any).tool_call_id));
    for (const c of last.tool_calls) {
      if (!answered.has(c.id)) this.history.push({ role: 'tool', tool_call_id: c.id, content: 'Interrumpido por el usuario.' });
    }
  }
}
