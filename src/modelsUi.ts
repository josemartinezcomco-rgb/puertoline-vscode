import * as vscode from 'vscode';
import { ModelEntry, PROVIDERS, getApiKey, listModels, resolveChain, secretName } from './providers';
import { ModelRouter } from './router';

type Item = vscode.QuickPickItem & { action?: () => unknown };

/** Models with tool support that run well locally, offered when pulling from Ollama. */
const OLLAMA_SUGGESTIONS = [
  { name: 'qwen2.5-coder:7b', note: '~4.7 GB · código, buena calidad con 8 GB de RAM/VRAM' },
  { name: 'qwen3:8b', note: '~5 GB · general + razonamiento' },
  { name: 'llama3.1:8b', note: '~4.9 GB · general' },
  { name: 'qwen2.5-coder:14b', note: '~9 GB · código, mejor calidad (16 GB+)' },
  { name: 'qwen2.5-coder:3b', note: '~1.9 GB · para equipos modestos' },
];

function config() {
  return vscode.workspace.getConfiguration('puertoline');
}

async function addToChain(entry: ModelEntry, position: 'start' | 'end'): Promise<void> {
  const chain = [...(config().get<ModelEntry[]>('models') ?? [])].filter(
    (e) => !(e.provider === entry.provider && e.model === entry.model)
  );
  if (position === 'start') chain.unshift(entry);
  else chain.push(entry);
  await config().update('models', chain, vscode.ConfigurationTarget.Global);
}

export function registerModelCommands(
  context: vscode.ExtensionContext,
  router: ModelRouter,
  output: vscode.OutputChannel
): vscode.Disposable[] {
  const log = (m: string) => output.appendLine(m);

  const setKey = async (providerId?: string) => {
    if (!providerId) {
      const items = await Promise.all(
        Object.entries(PROVIDERS)
          .filter(([, p]) => p.needsKey || p.baseUrl === '')
          .map(async ([id, p]) => ({
            label: `${(await getApiKey(context.secrets, id)) ? '$(key)' : '$(circle-outline)'} ${p.label}`,
            description: p.note,
            id,
          }))
      );
      const pick = await vscode.window.showQuickPick(items, { title: 'Configurar API key — ¿de qué proveedor?' });
      if (!pick) return;
      providerId = pick.id;
    }
    const p = PROVIDERS[providerId];
    const key = await vscode.window.showInputBox({
      title: `API key de ${p.label}`,
      prompt: p.keyUrl ? `Consíguela en ${p.keyUrl} (déjala vacía para borrarla)` : 'Déjala vacía para borrarla',
      password: true,
      ignoreFocusOut: true,
    });
    if (key === undefined) return;
    if (key.trim()) {
      await context.secrets.store(secretName(providerId), key.trim());
      router.resetCooldowns();
      vscode.window.showInformationMessage(`API key de ${p.label} guardada de forma segura.`);
    } else {
      await context.secrets.delete(secretName(providerId));
      vscode.window.showInformationMessage(`API key de ${p.label} eliminada.`);
    }
  };

  const addModel = async () => {
    const pick = await vscode.window.showQuickPick(
      Object.entries(PROVIDERS)
        .filter(([id]) => id !== 'custom')
        .map(([id, p]) => ({ label: p.label, description: p.note, id })),
      { title: 'Añadir modelo — proveedor' }
    );
    if (!pick) return;
    const p = PROVIDERS[pick.id];
    let apiKey = (await getApiKey(context.secrets, pick.id)) ?? '';
    if (p.needsKey && !apiKey) {
      await setKey(pick.id);
      apiKey = (await getApiKey(context.secrets, pick.id)) ?? '';
      if (!apiKey) return;
    }

    let models: string[] = [];
    try {
      models = await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: `Consultando modelos de ${p.label}…` },
        () => listModels(pick.id, p.baseUrl, apiKey, false)
      );
    } catch (e: any) {
      vscode.window.showWarningMessage(`No se pudo listar los modelos: ${e?.message ?? e}. Escribe el nombre a mano.`);
    }

    const items: (vscode.QuickPickItem & { model: string })[] = [];
    if (pick.id === 'ollama') items.push({ label: '$(sparkle) *', description: 'Todos los modelos instalados', model: '*' });
    if (pick.id === 'openrouter') items.push({ label: '$(sparkle) *free*', description: 'Todos los modelos gratuitos con herramientas (se actualiza solo)', model: '*free*' });
    items.push(...models.map((m) => ({ label: m, description: m.endsWith(':free') ? 'gratis' : undefined, model: m })));
    items.push({ label: '$(edit) Escribir nombre…', model: '' });

    const chosen = await vscode.window.showQuickPick(items, { title: `Modelo de ${p.label}`, matchOnDescription: true });
    if (!chosen) return;
    let model = chosen.model;
    if (!model) {
      model = (await vscode.window.showInputBox({ title: 'Nombre exacto del modelo' }))?.trim() ?? '';
      if (!model) return;
    }
    const where = await vscode.window.showQuickPick(
      [
        { label: 'Al final de la cadena', description: 'se usa como respaldo', v: 'end' as const },
        { label: 'Al principio', description: 'será el modelo principal', v: 'start' as const },
      ],
      { title: 'Posición en la cadena de respaldo' }
    );
    if (!where) return;
    await addToChain({ provider: pick.id, model }, where.v);
    router.resetCooldowns();
    vscode.window.showInformationMessage(`Añadido ${pick.id}/${model}.`);
  };

  const pullOllama = async () => {
    const items: (vscode.QuickPickItem & { name: string })[] = OLLAMA_SUGGESTIONS.map((s) => ({
      label: s.name,
      description: s.note,
      name: s.name,
    }));
    items.push({ label: '$(edit) Otro modelo…', description: 'ver https://ollama.com/search?c=tools', name: '' });
    const pick = await vscode.window.showQuickPick(items, { title: 'Descargar modelo de Ollama (debe soportar herramientas)' });
    if (!pick) return;
    const name = pick.name || (await vscode.window.showInputBox({ title: 'Nombre del modelo, p.ej. qwen2.5-coder:7b' }))?.trim();
    if (!name) return;
    const term = vscode.window.createTerminal({ name: `ollama pull ${name}` });
    term.show();
    term.sendText(`ollama pull ${name}`);
    const chain = config().get<ModelEntry[]>('models') ?? [];
    if (!chain.some((e) => e.provider === 'ollama' && (e.model === '*' || e.model === name))) {
      await addToChain({ provider: 'ollama', model: name }, 'end');
    }
    vscode.window.showInformationMessage(`Descargando ${name} en la terminal. Cuando termine, el agente lo usará automáticamente.`);
  };

  const showModels = async () => {
    const chain = await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Window, title: 'Resolviendo modelos…' },
      () => resolveChain(context.secrets, log)
    );
    const cooling = router.status();
    const items: Item[] = chain.map((m, i) => {
      const c = cooling.get(m.id);
      return {
        label: `${c ? '$(debug-pause)' : router.current?.id === m.id ? '$(play)' : '$(circle-filled)'} ${i + 1}. ${m.id}`,
        description: c ? `en pausa ${Math.ceil((c.until - Date.now()) / 1000)}s: ${c.reason}` : m.local ? 'local · gratis' : PROVIDERS[m.provider]?.note,
      };
    });
    const missing = (config().get<ModelEntry[]>('models') ?? []).filter((e) => !e.disabled && PROVIDERS[e.provider]?.needsKey);
    const missingKeys: Item[] = [];
    for (const e of missing) {
      if (!(await getApiKey(context.secrets, e.keyName || e.provider)) && !missingKeys.some((x) => x.label.includes(PROVIDERS[e.provider].label))) {
        missingKeys.push({
          label: `$(warning) ${PROVIDERS[e.provider].label}: sin API key (omitido)`,
          description: PROVIDERS[e.provider].note,
          action: () => setKey(e.provider),
        });
      }
    }
    if (!chain.length) items.push({ label: '$(warning) Ningún modelo disponible todavía' });
    items.push(
      ...missingKeys,
      { label: '', kind: vscode.QuickPickItemKind.Separator },
      { label: '$(add) Añadir modelo…', action: addModel },
      { label: '$(cloud-download) Descargar modelo de Ollama (gratis, local)…', action: pullOllama },
      { label: '$(key) Configurar API key…', action: () => setKey() },
      { label: '$(debug-restart) Quitar pausas (reintentar todos)', action: () => router.resetCooldowns() },
      {
        label: '$(settings-gear) Editar cadena de modelos (orden de respaldo)',
        action: () => vscode.commands.executeCommand('workbench.action.openSettingsJson', { revealSetting: { key: 'puertoline.models' } }),
      },
      { label: '$(output) Ver registro', action: () => output.show() }
    );
    const pick = await vscode.window.showQuickPick(items, {
      title: 'Modelos (en orden de respaldo: si uno falla se usa el siguiente)',
    });
    await pick?.action?.();
  };

  return [
    vscode.commands.registerCommand('puertoline.setApiKey', () => setKey()),
    vscode.commands.registerCommand('puertoline.models', showModels),
    vscode.commands.registerCommand('puertoline.addModel', addModel),
    vscode.commands.registerCommand('puertoline.pullOllama', pullOllama),
  ];
}
