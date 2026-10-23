import * as vscode from 'vscode';
import { Agent } from './agent';
import { ToolContext } from './tools';
import { McpManager } from './mcp';
import { ModelRouter } from './router';
import { registerModelCommands } from './modelsUi';
import { SkillRegistry, USER_SKILLS_DIR, installFromGitHub } from './skills';

const PROPOSED_SCHEME = 'puertoline-proposed';

const MCP_TEMPLATE = `{
  "mcpServers": {
    "filesystem-ejemplo": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-filesystem", "\${workspaceFolder}"],
      "disabled": true
    },
    "n8n-ejemplo": {
      "type": "http",
      "url": "https://TU-INSTANCIA.app.n8n.cloud/mcp-server/http",
      "headers": { "Authorization": "Bearer \${env:N8N_MCP_TOKEN}" },
      "disabled": true
    }
  }
}
`;

class ProposedContent implements vscode.TextDocumentContentProvider {
  readonly docs = new Map<string, string>();
  provideTextDocumentContent(uri: vscode.Uri): string {
    return this.docs.get(uri.toString()) ?? '';
  }
}

class ChatViewProvider implements vscode.WebviewViewProvider {
  private view?: vscode.WebviewView;
  private readonly agent: Agent;
  private readonly pending = new Map<string, (ok: boolean) => void>();
  private approvalSeq = 0;

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly proposed: ProposedContent,
    private readonly mcp: McpManager,
    router: ModelRouter,
    private readonly skills: SkillRegistry
  ) {
    this.agent = new Agent(router, (signal) => this.toolContext(signal));
    context.subscriptions.push(mcp.onDidChange(() => this.postMcpStatus()));
  }

  postMcpStatus(): void {
    const servers = this.mcp.status();
    this.post({
      type: 'mcpStatus',
      connected: servers.filter((s) => s.state === 'connected').length,
      total: servers.filter((s) => s.state !== 'disabled').length,
      connecting: servers.some((s) => s.state === 'connecting'),
      errors: servers.some((s) => s.state === 'error'),
    });
  }

  resolveWebviewView(view: vscode.WebviewView): void {
    this.view = view;
    view.webview.options = {
      enableScripts: true,
      localResourceRoots: [vscode.Uri.joinPath(this.context.extensionUri, 'media')],
    };
    view.webview.html = this.html(view.webview);

    view.webview.onDidReceiveMessage(async (msg) => {
      switch (msg.type) {
        case 'send':
          if (this.agent.busy) return;
          await this.agent.send(msg.text, (e) => this.post(e));
          break;
        case 'stop':
          this.agent.stop();
          this.rejectAllPending();
          break;
        case 'newChat':
          this.newChat();
          break;
        case 'setKey':
          await vscode.commands.executeCommand('puertoline.setApiKey');
          break;
        case 'settings':
          await vscode.commands.executeCommand('workbench.action.openSettings', 'puertoline');
          break;
        case 'approval':
          this.pending.get(msg.id)?.(msg.ok);
          this.pending.delete(msg.id);
          break;
        case 'mcp':
          await vscode.commands.executeCommand('puertoline.mcpStatus');
          break;
        case 'models':
          await vscode.commands.executeCommand('puertoline.models');
          break;
        case 'skills':
          await vscode.commands.executeCommand('puertoline.skills');
          break;
        case 'ready':
          this.postMcpStatus();
          await this.postSkills();
          void this.mcp.ready();
          break;
      }
    });
  }

  async postSkills(): Promise<void> {
    const list = await this.skills.all();
    this.post({ type: 'skills', skills: list.map((s) => ({ name: s.name, category: s.category, description: s.description.slice(0, 140) })) });
  }

  newChat(): void {
    this.agent.reset();
    this.rejectAllPending();
    this.post({ type: 'clear' });
  }

  post(msg: unknown): void {
    this.view?.webview.postMessage(msg);
  }

  private rejectAllPending(): void {
    for (const resolve of this.pending.values()) resolve(false);
    this.pending.clear();
  }

  private toolContext(signal: AbortSignal): ToolContext {
    return {
      root: vscode.workspace.workspaceFolders![0].uri,
      mcp: this.mcp,
      skills: this.skills,
      signal,
      approve: (kind, title, detail) =>
        new Promise<boolean>((resolve) => {
          if (signal.aborted) return resolve(false);
          const id = `a${++this.approvalSeq}`;
          this.pending.set(id, resolve);
          this.post({ type: 'approvalRequest', id, kind, title, detail });
        }),
      showDiff: async (file, proposedText, title) => {
        const right = vscode.Uri.from({ scheme: PROPOSED_SCHEME, path: file.path, query: String(Date.now()) });
        this.proposed.docs.set(right.toString(), proposedText);
        let left = file;
        try {
          await vscode.workspace.fs.stat(file);
        } catch {
          left = vscode.Uri.from({ scheme: PROPOSED_SCHEME, path: file.path, query: 'empty' });
          this.proposed.docs.set(left.toString(), '');
        }
        await vscode.commands.executeCommand('vscode.diff', left, right, `${title} (propuesta)`, { preview: true });
      },
    };
  }

  private html(webview: vscode.Webview): string {
    const media = (f: string) => webview.asWebviewUri(vscode.Uri.joinPath(this.context.extensionUri, 'media', f));
    const nonce = Math.random().toString(36).slice(2) + Math.random().toString(36).slice(2);
    return `<!DOCTYPE html>
<html lang="es">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource}; script-src 'nonce-${nonce}';">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<link rel="stylesheet" href="${media('chat.css')}">
</head>
<body>
  <div id="toolbar">
    <button id="model" title="Modelos y respaldo">🤖 auto</button>
    <span class="spacer"></span>
    <button id="skills" title="Skills">📚</button>
    <button id="mcp" title="Servidores MCP">🔌 –</button>
    <button id="key" title="Configurar API key">🔑</button>
    <button id="settings" title="Ajustes">⚙</button>
    <button id="new" title="Nueva conversación">＋</button>
  </div>
  <div id="messages">
    <div class="empty">
      <h3>Puertoline</h3>
      <p>Programación, diseño, marketing digital y contenido sobre tu proyecto.<br>Ejemplos:</p>
      <ul>
        <li>Explícame la estructura de este proyecto</li>
        <li>Diseña una landing page moderna para este producto</li>
        <li><code>/seo-audit</code> revisa el SEO de index.html</li>
        <li><code>/social</code> crea 10 posts para LinkedIn sobre este lanzamiento</li>
      </ul>
      <p>Escribe <code>/</code> para ver las skills.</p>
    </div>
  </div>
  <form id="composer">
    <div id="suggest" hidden></div>
    <textarea id="input" rows="3" placeholder="Escribe una tarea… (Enter envía, Shift+Enter nueva línea)"></textarea>
    <div class="row">
      <span id="status"></span>
      <button type="button" id="stop" hidden>Detener</button>
      <button type="submit" id="send">Enviar</button>
    </div>
  </form>
<script nonce="${nonce}" src="${media('chat.js')}"></script>
</body>
</html>`;
  }
}

export function activate(context: vscode.ExtensionContext): void {
  const proposed = new ProposedContent();
  const output = vscode.window.createOutputChannel('Puertoline');
  const mcp = new McpManager(output);
  const router = new ModelRouter(context.secrets, (m) => output.appendLine(m), context.globalState);
  const skills = new SkillRegistry(vscode.Uri.joinPath(context.extensionUri, 'skills').fsPath);
  const provider = new ChatViewProvider(context, proposed, mcp, router, skills);

  const installSkills = async () => {
    const spec = await vscode.window.showInputBox({
      title: 'Instalar skills desde GitHub',
      prompt: 'usuario/repositorio (o con subcarpeta). Ej: coreyhaines31/marketingskills, obra/superpowers, anthropics/skills/skills/pdf',
      ignoreFocusOut: true,
    });
    if (!spec) return;
    try {
      const names = await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: `Descargando skills de ${spec}…` },
        () => installFromGitHub(spec, (m) => output.appendLine(`[skills] ${m}`))
      );
      skills.invalidate();
      await provider.postSkills();
      vscode.window.showInformationMessage(`Instaladas ${names.length} skills: ${names.slice(0, 8).join(', ')}${names.length > 8 ? '…' : ''}`);
    } catch (e: any) {
      vscode.window.showErrorMessage(`No se pudieron instalar: ${e?.message ?? e}`);
    }
  };

  const showSkills = async () => {
    skills.invalidate();
    const list = await skills.all();
    type Item = vscode.QuickPickItem & { action?: () => unknown };
    const items: Item[] = [];
    let cat = '';
    for (const s of list) {
      if (s.category !== cat) {
        cat = s.category;
        items.push({ label: cat, kind: vscode.QuickPickItemKind.Separator });
      }
      items.push({
        label: `/${s.name}`,
        description: s.source === 'incluida' ? undefined : s.source,
        detail: s.description.slice(0, 200),
        action: () => vscode.window.showTextDocument(vscode.Uri.file(`${s.dir}/SKILL.md`)),
      });
    }
    items.push(
      { label: '', kind: vscode.QuickPickItemKind.Separator },
      { label: '$(cloud-download) Instalar skills desde GitHub…', action: installSkills },
      {
        label: '$(folder-opened) Abrir carpeta de mis skills',
        detail: USER_SKILLS_DIR,
        action: async () => {
          await vscode.workspace.fs.createDirectory(vscode.Uri.file(USER_SKILLS_DIR));
          await vscode.env.openExternal(vscode.Uri.file(USER_SKILLS_DIR));
        },
      }
    );
    const pick = await vscode.window.showQuickPick(items, {
      title: `Skills (${list.length}) — escribe /nombre en el chat para usar una`,
      matchOnDetail: true,
    });
    await pick?.action?.();
    await provider.postSkills();
  };

  const openMcpConfig = async () => {
    const root = vscode.workspace.workspaceFolders?.[0]?.uri;
    if (!root) {
      vscode.window.showWarningMessage('Abre una carpeta de proyecto primero.');
      return;
    }
    const file = vscode.Uri.joinPath(root, '.mcp.json');
    try {
      await vscode.workspace.fs.stat(file);
    } catch {
      await vscode.workspace.fs.writeFile(file, new TextEncoder().encode(MCP_TEMPLATE));
    }
    await vscode.window.showTextDocument(file);
  };

  context.subscriptions.push(
    output,
    mcp,
    vscode.commands.registerCommand('puertoline.mcpConfig', openMcpConfig),
    vscode.commands.registerCommand('puertoline.mcpReload', async () => {
      await mcp.reload();
      vscode.window.showInformationMessage(
        `MCP: ${mcp.status().filter((s) => s.state === 'connected').length} servidor(es) conectado(s).`
      );
    }),
    vscode.commands.registerCommand('puertoline.mcpStatus', async () => {
      await mcp.ready();
      const icon = { connected: '$(pass-filled)', connecting: '$(loading~spin)', error: '$(error)', disabled: '$(circle-slash)' };
      const items: (vscode.QuickPickItem & { action?: () => unknown })[] = mcp.status().map((s) => ({
        label: `${icon[s.state]} ${s.name}`,
        description: s.state === 'connected' ? `${s.tools.length} herramientas · ${s.source}` : `${s.state} · ${s.source}`,
        detail: s.error ?? (s.tools.join(', ') || undefined),
        action: () => output.show(),
      }));
      items.push(
        { label: '', kind: vscode.QuickPickItemKind.Separator },
        { label: '$(edit) Editar .mcp.json del proyecto', action: openMcpConfig },
        { label: '$(refresh) Reconectar servidores', action: () => vscode.commands.executeCommand('puertoline.mcpReload') },
        { label: '$(output) Ver registro', action: () => output.show() }
      );
      const pick = await vscode.window.showQuickPick(items, {
        title: 'Servidores MCP',
        placeHolder: items.length > 4 ? 'Estado de los servidores' : 'No hay servidores MCP configurados',
      });
      await pick?.action?.();
    }),
    vscode.workspace.registerTextDocumentContentProvider(PROPOSED_SCHEME, proposed),
    vscode.window.registerWebviewViewProvider('puertoline.chat', provider, {
      webviewOptions: { retainContextWhenHidden: true },
    }),
    ...registerModelCommands(context, router, output),
    vscode.commands.registerCommand('puertoline.skills', showSkills),
    vscode.commands.registerCommand('puertoline.installSkills', installSkills),
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration('puertoline.disabledSkills')) void provider.postSkills();
    }),
    vscode.commands.registerCommand('puertoline.newChat', () => provider.newChat()),
    vscode.commands.registerCommand('puertoline.focus', () =>
      vscode.commands.executeCommand('puertoline.chat.focus')
    )
  );
}

export function deactivate(): void {}
