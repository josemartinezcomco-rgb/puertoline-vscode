import * as vscode from 'vscode';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js';
import { ToolSpec } from './llm';

/**
 * Server definition. Accepts the formats used by Claude Code (.mcp.json → "mcpServers")
 * and VS Code (.vscode/mcp.json → "servers").
 */
export interface McpServerConfig {
  type?: 'stdio' | 'http' | 'sse';
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  cwd?: string;
  url?: string;
  headers?: Record<string, string>;
  /** Run this server's tools without asking for approval. */
  trust?: boolean;
  disabled?: boolean;
}

export interface McpServerStatus {
  name: string;
  source: string;
  state: 'connecting' | 'connected' | 'error' | 'disabled';
  tools: string[];
  error?: string;
}

interface McpTool {
  server: string;
  name: string;
  description: string;
  inputSchema: object;
}

interface Connection {
  name: string;
  source: string;
  config: McpServerConfig;
  client?: Client;
  status: McpServerStatus;
}

export const MCP_PREFIX = 'mcp__';

/** OpenAI-style APIs require tool names matching ^[a-zA-Z0-9_-]{1,64}$. */
function toolId(server: string, tool: string): string {
  const clean = (s: string) => s.replace(/[^a-zA-Z0-9_-]/g, '_');
  return `${MCP_PREFIX}${clean(server)}__${clean(tool)}`.slice(0, 64);
}

/** Expands ${env:VAR}, ${VAR} and ${workspaceFolder}. */
function expand(value: string, root: string | undefined): string {
  return value.replace(/\$\{(env:)?([A-Za-z0-9_]+)\}/g, (m, _env, name) => {
    if (name === 'workspaceFolder') return root ?? m;
    return process.env[name] ?? m;
  });
}

function expandAll<T>(v: T, root: string | undefined): T {
  if (typeof v === 'string') return expand(v, root) as T;
  if (Array.isArray(v)) return v.map((x) => expandAll(x, root)) as T;
  if (v && typeof v === 'object') {
    return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, expandAll(x, root)])) as T;
  }
  return v;
}

export class McpManager implements vscode.Disposable {
  private connections = new Map<string, Connection>();
  private tools = new Map<string, McpTool>();
  private loading?: Promise<void>;
  private readonly changed = new vscode.EventEmitter<void>();
  readonly onDidChange = this.changed.event;
  private readonly watchers: vscode.Disposable[] = [];

  constructor(private readonly output: vscode.OutputChannel) {
    for (const glob of ['.mcp.json', '.vscode/mcp.json']) {
      const w = vscode.workspace.createFileSystemWatcher(`**/${glob}`);
      const reload = () => this.reload();
      w.onDidChange(reload);
      w.onDidCreate(reload);
      w.onDidDelete(reload);
      this.watchers.push(w);
    }
    this.watchers.push(
      vscode.workspace.onDidChangeConfiguration((e) => {
        if (e.affectsConfiguration('puertoline.mcpServers')) this.reload();
      })
    );
  }

  /** Connects to all configured servers (once). Safe to call repeatedly. */
  ready(): Promise<void> {
    this.loading ??= this.connectAll();
    return this.loading;
  }

  async reload(): Promise<void> {
    await this.loading?.catch(() => undefined);
    await this.closeAll();
    this.loading = this.connectAll();
    return this.loading;
  }

  status(): McpServerStatus[] {
    return [...this.connections.values()].map((c) => c.status);
  }

  toolSpecs(): ToolSpec[] {
    return [...this.tools.entries()].map(([id, t]) => ({
      type: 'function',
      function: {
        name: id,
        description: `[MCP ${t.server}] ${t.description}`.slice(0, 1024),
        parameters: t.inputSchema,
      },
    }));
  }

  has(id: string): boolean {
    return this.tools.has(id);
  }

  describe(id: string): { server: string; tool: string; trusted: boolean } | undefined {
    const t = this.tools.get(id);
    if (!t) return undefined;
    return { server: t.server, tool: t.name, trusted: !!this.connections.get(t.server)?.config.trust };
  }

  async call(id: string, args: Record<string, unknown>, signal: AbortSignal): Promise<{ text: string; isError: boolean }> {
    const t = this.tools.get(id);
    const client = t && this.connections.get(t.server)?.client;
    if (!t || !client) throw new Error(`Herramienta MCP no disponible: ${id}`);

    const result: any = await client.callTool({ name: t.name, arguments: args }, undefined, {
      signal,
      timeout: 10 * 60_000,
      resetTimeoutOnProgress: true,
    });

    const parts: string[] = [];
    for (const c of result.content ?? []) {
      if (c.type === 'text') parts.push(c.text);
      else if (c.type === 'resource') parts.push(c.resource?.text ?? `[recurso ${c.resource?.uri}]`);
      else if (c.type === 'resource_link') parts.push(`[recurso ${c.uri}] ${c.name ?? ''}`);
      else if (c.type === 'image' || c.type === 'audio') parts.push(`[${c.type} ${c.mimeType} omitido]`);
    }
    if (result.structuredContent && !parts.length) parts.push(JSON.stringify(result.structuredContent, null, 2));
    if (result.toolResult !== undefined && !parts.length) parts.push(JSON.stringify(result.toolResult, null, 2));
    return { text: parts.join('\n') || '(sin contenido)', isError: !!result.isError };
  }

  private async loadConfigs(): Promise<Map<string, { config: McpServerConfig; source: string }>> {
    const found = new Map<string, { config: McpServerConfig; source: string }>();
    const add = (servers: unknown, source: string) => {
      if (!servers || typeof servers !== 'object') return;
      for (const [name, config] of Object.entries(servers as Record<string, McpServerConfig>)) {
        found.set(name, { config, source });
      }
    };

    // Lowest precedence first: user settings, then project files.
    add(vscode.workspace.getConfiguration('puertoline').get('mcpServers'), 'ajustes');

    const root = vscode.workspace.workspaceFolders?.[0]?.uri;
    if (root) {
      for (const [file, key] of [
        ['.vscode/mcp.json', 'servers'],
        ['.mcp.json', 'mcpServers'],
      ] as const) {
        try {
          const bytes = await vscode.workspace.fs.readFile(vscode.Uri.joinPath(root, file));
          // Allow // comments, as VS Code does in mcp.json.
          const text = new TextDecoder().decode(bytes).replace(/^\s*\/\/.*$/gm, '');
          add(JSON.parse(text)[key], file);
        } catch (e: any) {
          if (e?.code !== 'FileNotFound' && !(e instanceof vscode.FileSystemError)) {
            this.output.appendLine(`[mcp] No se pudo leer ${file}: ${e?.message ?? e}`);
          }
        }
      }
    }
    return found;
  }

  private async connectAll(): Promise<void> {
    const configs = await this.loadConfigs();
    const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;

    for (const [name, { config, source }] of configs) {
      this.connections.set(name, {
        name,
        source,
        config: expandAll(config, root),
        status: { name, source, state: config.disabled ? 'disabled' : 'connecting', tools: [] },
      });
    }
    this.changed.fire();

    await Promise.all(
      [...this.connections.values()].filter((c) => !c.config.disabled).map((c) => this.connect(c, root))
    );
    this.changed.fire();
  }

  private async connect(conn: Connection, root: string | undefined): Promise<void> {
    const { name, config } = conn;
    const log = (msg: string) => this.output.appendLine(`[mcp:${name}] ${msg}`);
    try {
      const client = new Client({ name: 'puertoline', version: '0.2.0' });
      const type = config.type ?? (config.url ? 'http' : 'stdio');

      if (type === 'stdio') {
        if (!config.command) throw new Error('Falta "command"');
        const transport = new StdioClientTransport({
          command: config.command,
          args: config.args ?? [],
          env: { ...(process.env as Record<string, string>), ...(config.env ?? {}) },
          cwd: config.cwd ?? root,
          stderr: 'pipe',
        });
        transport.stderr?.on('data', (d) => log(d.toString().trimEnd()));
        await client.connect(transport);
      } else {
        if (!config.url) throw new Error('Falta "url"');
        const url = new URL(config.url);
        const requestInit = { headers: config.headers ?? {} };
        if (type === 'sse') {
          await client.connect(new SSEClientTransport(url, { requestInit }));
        } else {
          try {
            await client.connect(new StreamableHTTPClientTransport(url, { requestInit }));
          } catch (e: any) {
            log(`Streamable HTTP falló (${e?.message}); probando SSE…`);
            await client.connect(new SSEClientTransport(url, { requestInit }));
          }
        }
      }

      const names: string[] = [];
      let cursor: string | undefined;
      do {
        const page = await client.listTools(cursor ? { cursor } : undefined);
        for (const t of page.tools) {
          const { $schema: _ignored, ...inputSchema } = (t.inputSchema ?? { type: 'object', properties: {} }) as any;
          this.tools.set(toolId(name, t.name), {
            server: name,
            name: t.name,
            description: t.description ?? t.title ?? t.name,
            inputSchema,
          });
          names.push(t.name);
        }
        cursor = page.nextCursor;
      } while (cursor);

      client.onclose = () => {
        if (conn.client !== client) return;
        log('desconectado');
        conn.client = undefined;
        conn.status = { ...conn.status, state: 'error', error: 'Conexión cerrada' };
        for (const [id, t] of this.tools) if (t.server === name) this.tools.delete(id);
        this.changed.fire();
      };

      conn.client = client;
      conn.status = { name, source: conn.source, state: 'connected', tools: names };
      log(`conectado: ${names.length} herramientas (${names.join(', ')})`);
    } catch (e: any) {
      conn.status = { name, source: conn.source, state: 'error', tools: [], error: e?.message ?? String(e) };
      log(`error: ${conn.status.error}`);
    }
  }

  private async closeAll(): Promise<void> {
    const clients = [...this.connections.values()].map((c) => c.client).filter(Boolean) as Client[];
    this.connections.clear();
    this.tools.clear();
    await Promise.all(clients.map((c) => c.close().catch(() => undefined)));
  }

  dispose(): void {
    this.watchers.forEach((w) => w.dispose());
    this.changed.dispose();
    void this.closeAll();
  }
}
