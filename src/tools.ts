import * as vscode from 'vscode';
import * as path from 'path';
import { spawn } from 'child_process';
import { ToolSpec } from './llm';
import { McpManager } from './mcp';
import { SkillRegistry } from './skills';

export interface ToolContext {
  root: vscode.Uri;
  mcp: McpManager;
  skills: SkillRegistry;
  /** Ask the user to approve a risky action. Resolves true if allowed. */
  approve(kind: 'edit' | 'command' | 'mcp' | 'http', title: string, detail: string): Promise<boolean>;
  showDiff(file: vscode.Uri, proposed: string, title: string): Promise<void>;
  signal: AbortSignal;
}

const MAX_OUTPUT = 30_000;
const IGNORE = '**/{node_modules,.git,out,dist,build,.next,.venv,venv,__pycache__}/**';

function obj(properties: Record<string, object>, required: string[]): object {
  return { type: 'object', properties, required };
}

export const TOOL_SPECS: ToolSpec[] = [
  {
    type: 'function',
    function: {
      name: 'use_skill',
      description:
        'Carga las instrucciones completas de una skill del catálogo (metodologías expertas de programación, diseño, marketing y contenido). Úsala ANTES de empezar una tarea que encaje con alguna skill. Con "file" lee uno de sus archivos de apoyo.',
      parameters: obj(
        {
          name: { type: 'string', description: 'Nombre exacto de la skill' },
          file: { type: 'string', description: 'Opcional: ruta relativa de un archivo de apoyo de la skill' },
        },
        ['name']
      ),
    },
  },
  {
    type: 'function',
    function: {
      name: 'list_dir',
      description: 'Lista archivos y carpetas de un directorio (relativo a la raíz del proyecto).',
      parameters: obj({ path: { type: 'string', description: 'Directorio, "." para la raíz' } }, ['path']),
    },
  },
  {
    type: 'function',
    function: {
      name: 'find_files',
      description: 'Busca archivos por patrón glob, p.ej. "src/**/*.ts".',
      parameters: obj({ pattern: { type: 'string' } }, ['pattern']),
    },
  },
  {
    type: 'function',
    function: {
      name: 'search_text',
      description: 'Busca una expresión regular en el contenido de los archivos. Devuelve archivo:línea: texto.',
      parameters: obj(
        {
          regex: { type: 'string' },
          include: { type: 'string', description: 'Glob opcional para filtrar archivos, p.ej. "**/*.py"' },
        },
        ['regex']
      ),
    },
  },
  {
    type: 'function',
    function: {
      name: 'read_file',
      description: 'Lee un archivo de texto con números de línea. Usa offset/limit para archivos grandes.',
      parameters: obj(
        {
          path: { type: 'string' },
          offset: { type: 'number', description: 'Línea inicial (1-based)' },
          limit: { type: 'number', description: 'Número de líneas' },
        },
        ['path']
      ),
    },
  },
  {
    type: 'function',
    function: {
      name: 'write_file',
      description: 'Crea o sobrescribe un archivo completo. Para cambios pequeños usa edit_file.',
      parameters: obj({ path: { type: 'string' }, content: { type: 'string' } }, ['path', 'content']),
    },
  },
  {
    type: 'function',
    function: {
      name: 'edit_file',
      description:
        'Reemplaza un texto exacto en un archivo. old_string debe aparecer exactamente una vez (incluida la indentación) salvo que replace_all sea true. Lee el archivo antes de editarlo.',
      parameters: obj(
        {
          path: { type: 'string' },
          old_string: { type: 'string' },
          new_string: { type: 'string' },
          replace_all: { type: 'boolean' },
        },
        ['path', 'old_string', 'new_string']
      ),
    },
  },
  {
    type: 'function',
    function: {
      name: 'run_command',
      description:
        'Ejecuta un comando de shell en la raíz del proyecto (PowerShell en Windows, bash en Linux/macOS) y devuelve stdout/stderr y el código de salida. Útil para instalar dependencias, compilar, ejecutar tests o git.',
      parameters: obj({ command: { type: 'string' } }, ['command']),
    },
  },
  {
    type: 'function',
    function: {
      name: 'http_request',
      description:
        'Hace una petición HTTP a cualquier API REST/webhook y devuelve estado, cabeceras y cuerpo. En cabeceras y URL puedes usar ${env:NOMBRE} para leer variables de entorno (p.ej. tokens) sin escribirlos en claro.',
      parameters: obj(
        {
          method: { type: 'string', enum: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD'] },
          url: { type: 'string' },
          headers: { type: 'object', additionalProperties: { type: 'string' } },
          body: { description: 'Cuerpo: string, o un objeto que se enviará como JSON' },
        },
        ['method', 'url']
      ),
    },
  },
];

function expandEnv(s: string): string {
  return s.replace(/\$\{env:([A-Za-z0-9_]+)\}/g, (m, name) => process.env[name] ?? m);
}

function resolve(ctx: ToolContext, p: string): vscode.Uri {
  const rootPath = ctx.root.fsPath;
  const abs = path.resolve(rootPath, p || '.');
  const rel = path.relative(rootPath, abs);
  if (rel.startsWith('..') || path.isAbsolute(rel)) {
    throw new Error(`Ruta fuera del proyecto: ${p}`);
  }
  return vscode.Uri.file(abs);
}

async function readText(uri: vscode.Uri): Promise<string> {
  return new TextDecoder().decode(await vscode.workspace.fs.readFile(uri));
}

async function writeText(uri: vscode.Uri, text: string): Promise<void> {
  await vscode.workspace.fs.createDirectory(vscode.Uri.file(path.dirname(uri.fsPath)));
  await vscode.workspace.fs.writeFile(uri, new TextEncoder().encode(text));
}

async function exists(uri: vscode.Uri): Promise<boolean> {
  try {
    await vscode.workspace.fs.stat(uri);
    return true;
  } catch {
    return false;
  }
}

function truncate(s: string): string {
  return s.length > MAX_OUTPUT ? s.slice(0, MAX_OUTPUT) + `\n... [truncado, ${s.length - MAX_OUTPUT} caracteres más]` : s;
}

export async function runTool(name: string, args: any, ctx: ToolContext): Promise<string> {
  const cfg = vscode.workspace.getConfiguration('puertoline');

  switch (name) {
    case 'use_skill':
      return truncate(await ctx.skills.read(args.name, args.file));

    case 'list_dir': {
      const uri = resolve(ctx, args.path);
      const entries = await vscode.workspace.fs.readDirectory(uri);
      entries.sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
      return entries.map(([n, t]) => (t === vscode.FileType.Directory ? `${n}/` : n)).join('\n') || '(vacío)';
    }

    case 'find_files': {
      const files = await vscode.workspace.findFiles(new vscode.RelativePattern(ctx.root, args.pattern), IGNORE, 500);
      return files.map((f) => vscode.workspace.asRelativePath(f, false)).sort().join('\n') || '(sin resultados)';
    }

    case 'search_text': {
      const re = new RegExp(args.regex);
      const files = await vscode.workspace.findFiles(
        new vscode.RelativePattern(ctx.root, args.include || '**/*'),
        IGNORE,
        3000
      );
      const out: string[] = [];
      for (const f of files) {
        if (ctx.signal.aborted || out.length >= 300) break;
        let text: string;
        try {
          const bytes = await vscode.workspace.fs.readFile(f);
          if (bytes.length > 1_000_000 || bytes.includes(0)) continue;
          text = new TextDecoder().decode(bytes);
        } catch {
          continue;
        }
        const lines = text.split(/\r?\n/);
        for (let i = 0; i < lines.length && out.length < 300; i++) {
          if (re.test(lines[i])) {
            out.push(`${vscode.workspace.asRelativePath(f, false)}:${i + 1}: ${lines[i].trim().slice(0, 200)}`);
          }
        }
      }
      return out.join('\n') || '(sin coincidencias)';
    }

    case 'read_file': {
      const uri = resolve(ctx, args.path);
      const lines = (await readText(uri)).split(/\r?\n/);
      const start = Math.max(1, args.offset ?? 1);
      const end = Math.min(lines.length, start - 1 + (args.limit ?? 2000));
      const body = lines
        .slice(start - 1, end)
        .map((l, i) => `${String(start + i).padStart(5)}\t${l}`)
        .join('\n');
      const more = end < lines.length ? `\n... (${lines.length - end} líneas más; usa offset)` : '';
      return truncate(body + more);
    }

    case 'write_file': {
      const uri = resolve(ctx, args.path);
      const isNew = !(await exists(uri));
      if (!cfg.get<boolean>('autoApproveEdits')) {
        await ctx.showDiff(uri, args.content, `${isNew ? 'Crear' : 'Sobrescribir'} ${args.path}`);
        const ok = await ctx.approve('edit', `${isNew ? 'Crear' : 'Sobrescribir'} ${args.path}`, args.content.slice(0, 4000));
        if (!ok) return 'El usuario rechazó el cambio. Pregunta qué quiere hacer en su lugar.';
      }
      await writeText(uri, args.content);
      return `Archivo ${isNew ? 'creado' : 'actualizado'}: ${args.path}`;
    }

    case 'edit_file': {
      const uri = resolve(ctx, args.path);
      const original = await readText(uri);
      const { old_string, new_string, replace_all } = args;
      if (!old_string) throw new Error('old_string vacío');
      const count = original.split(old_string).length - 1;
      if (count === 0) {
        // Common mismatch: model sends \n but file uses \r\n.
        if (original.includes('\r\n') && original.includes(old_string.replace(/\r?\n/g, '\r\n'))) {
          return runTool(
            name,
            {
              ...args,
              old_string: old_string.replace(/\r?\n/g, '\r\n'),
              new_string: new_string.replace(/\r?\n/g, '\r\n'),
            },
            ctx
          );
        }
        throw new Error('old_string no se encontró en el archivo. Vuelve a leerlo y copia el texto exacto.');
      }
      if (count > 1 && !replace_all) {
        throw new Error(`old_string aparece ${count} veces; añade más contexto o usa replace_all.`);
      }
      const updated = replace_all
        ? original.split(old_string).join(new_string)
        : original.replace(old_string, () => new_string);
      if (!cfg.get<boolean>('autoApproveEdits')) {
        await ctx.showDiff(uri, updated, `Editar ${args.path}`);
        const ok = await ctx.approve('edit', `Editar ${args.path}`, `- ${old_string.slice(0, 1500)}\n+ ${new_string.slice(0, 1500)}`);
        if (!ok) return 'El usuario rechazó el cambio. Pregunta qué quiere hacer en su lugar.';
      }
      await writeText(uri, updated);
      return `Editado ${args.path} (${replace_all ? count : 1} reemplazo/s).`;
    }

    case 'run_command': {
      if (!cfg.get<boolean>('autoApproveCommands')) {
        const ok = await ctx.approve('command', 'Ejecutar comando', args.command);
        if (!ok) return 'El usuario rechazó ejecutar el comando.';
      }
      return truncate(await exec(args.command, ctx.root.fsPath, cfg.get<number>('commandTimeoutSeconds') ?? 120, ctx.signal));
    }

    case 'http_request': {
      const method = String(args.method || 'GET').toUpperCase();
      if (!cfg.get<boolean>('autoApproveHttp')) {
        const preview = args.body === undefined ? '' : `\n\n${typeof args.body === 'string' ? args.body : JSON.stringify(args.body, null, 2)}`;
        const ok = await ctx.approve('http', `${method} ${args.url}`, `${method} ${args.url}${preview}`.slice(0, 4000));
        if (!ok) return 'El usuario rechazó la petición HTTP.';
      }
      const headers: Record<string, string> = {};
      for (const [k, v] of Object.entries(args.headers ?? {})) headers[k] = expandEnv(String(v));
      let body: string | undefined;
      if (args.body !== undefined && method !== 'GET' && method !== 'HEAD') {
        if (typeof args.body === 'string') {
          body = args.body;
        } else {
          body = JSON.stringify(args.body);
          if (!Object.keys(headers).some((h) => h.toLowerCase() === 'content-type')) headers['Content-Type'] = 'application/json';
        }
      }
      const timeout = AbortSignal.timeout((cfg.get<number>('commandTimeoutSeconds') ?? 120) * 1000);
      const res = await fetch(expandEnv(args.url), { method, headers, body, signal: AbortSignal.any([ctx.signal, timeout]) });
      let text = await res.text();
      try {
        text = JSON.stringify(JSON.parse(text), null, 2);
      } catch {
        /* not JSON */
      }
      const resHeaders = [...res.headers.entries()]
        .filter(([k]) => /content-type|location|retry-after|x-ratelimit/i.test(k))
        .map(([k, v]) => `${k}: ${v}`)
        .join('\n');
      return truncate(`HTTP ${res.status} ${res.statusText}\n${resHeaders}\n\n${text}`);
    }

    default:
      if (ctx.mcp.has(name)) return runMcpTool(name, args, ctx);
      throw new Error(`Herramienta desconocida: ${name}`);
  }
}

async function runMcpTool(id: string, args: any, ctx: ToolContext): Promise<string> {
  const info = ctx.mcp.describe(id)!;
  const cfg = vscode.workspace.getConfiguration('puertoline');
  if (!info.trusted && !cfg.get<boolean>('autoApproveMcp')) {
    const ok = await ctx.approve('mcp', `${info.server} → ${info.tool}`, JSON.stringify(args, null, 2).slice(0, 4000));
    if (!ok) return 'El usuario rechazó la llamada a la herramienta MCP.';
  }
  const { text, isError } = await ctx.mcp.call(id, args, ctx.signal);
  if (isError) throw new Error(truncate(text));
  return truncate(text);
}

function exec(command: string, cwd: string, timeoutSec: number, signal: AbortSignal): Promise<string> {
  return new Promise((resolvePromise) => {
    const isWin = process.platform === 'win32';
    const child = isWin
      ? spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', command], { cwd })
      : spawn('/bin/bash', ['-lc', command], { cwd });

    let out = '';
    const append = (d: Buffer) => {
      if (out.length < MAX_OUTPUT * 2) out += d.toString();
    };
    child.stdout.on('data', append);
    child.stderr.on('data', append);

    const kill = () => child.kill();
    const timer = setTimeout(() => {
      out += `\n[timeout tras ${timeoutSec}s]`;
      kill();
    }, timeoutSec * 1000);
    signal.addEventListener('abort', kill, { once: true });

    child.on('error', (e) => {
      clearTimeout(timer);
      resolvePromise(`Error al ejecutar: ${e.message}`);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      signal.removeEventListener('abort', kill);
      resolvePromise(`${out.trim() || '(sin salida)'}\n[exit code: ${code}]`);
    });
  });
}
