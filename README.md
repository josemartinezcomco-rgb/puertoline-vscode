# Puertoline

Agente de IA para VS Code, al estilo de Claude Code, para **programación, diseño, marketing digital y creación de contenido**. Chateas en el panel lateral y el agente explora tu proyecto, lee y edita archivos, ejecuta comandos y usa skills expertas, iterando hasta terminar la tarea.

- **Gratis:** Ollama (local) y los planes gratuitos de OpenRouter, Gemini, Groq, Cerebras, Mistral y GitHub Models, además de DeepSeek o cualquier API compatible con OpenAI.
- **Nunca se queda parado:** si un modelo falla o llega a su límite, pasa al siguiente sin perder la tarea.
- **40 skills incluidas** de diseño, programación, marketing y contenido, y puedes instalar más desde GitHub.
- **Integraciones** con cualquier servidor MCP (n8n, GitHub, Playwright…) y APIs REST.

## Instalar

**Windows (PowerShell):**

```powershell
irm https://raw.githubusercontent.com/josemartinezcomco-rgb/puertoline-vscode/main/install.ps1 | iex
```

**macOS / Linux:**

```bash
curl -fsSL https://raw.githubusercontent.com/josemartinezcomco-rgb/puertoline-vscode/main/install.sh | bash
```

O manualmente: descarga el `.vsix` de la [última release](https://github.com/josemartinezcomco-rgb/puertoline-vscode/releases/latest) y en VS Code `Ctrl+Shift+P` → **Extensions: Install from VSIX...**

Después:

1. Recarga VS Code y abre el panel **Puertoline** en la barra lateral (`Ctrl+Alt+D`).
2. Configura al menos un modelo (pulsa el botón **🤖** del panel):
   - **Gratis y local:** *Descargar modelo de Ollama* (p. ej. `qwen2.5-coder:7b`).
   - **Gratis en la nube:** *Configurar API key* → OpenRouter, Gemini, Groq… (las claves se guardan cifradas).
3. Abre una carpeta de proyecto y escribe tu tarea.

## Skills

Las skills son metodologías expertas en formato `SKILL.md`, el mismo que usa Claude Code. El agente ve el catálogo y carga la skill adecuada cuando la tarea encaja. También puedes invocarla tú escribiendo **`/nombre`** en el chat; al teclear `/` se abre un autocompletado.

| Categoría | Skills incluidas |
|---|---|
| 🎨 Diseño | `frontend-design`, `canvas-design`, `theme-factory`, `frontend-ui-engineering` |
| 💻 Programación | `brainstorming`, `writing-plans`, `executing-plans`, `test-driven-development`, `systematic-debugging`, `verification-before-completion`, `receiving-code-review`, `code-review-and-quality`, `security-and-hardening`, `performance-optimization`, `api-and-interface-design`, `git-workflow-and-versioning`, `documentation-and-adrs`, `mcp-builder`, `webapp-testing` |
| 📈 Marketing digital | `marketing-plan`, `copywriting`, `copy-editing`, `seo-audit`, `ai-seo`, `programmatic-seo`, `cro`, `ads`, `ad-creative`, `emails`, `launch`, `pricing`, `marketing-psychology`, `competitors`, `customer-research`, `analytics` |
| ✍️ Contenido | `content-strategy`, `social`, `video`, `image`, `lead-magnets` |

Proceden de [obra/superpowers](https://github.com/obra/superpowers), [addyosmani/agent-skills](https://github.com/addyosmani/agent-skills), [coreyhaines31/marketingskills](https://github.com/coreyhaines31/marketingskills) y [anthropics/skills](https://github.com/anthropics/skills). Los créditos y licencias están en [skills/README.md](skills/README.md).

**Más skills:** el botón **📚** → *Instalar skills desde GitHub* acepta `usuario/repositorio` (por ejemplo `AgriciDaniel/claude-seo`) y las guarda en `~/.puertoline/skills`. Puertoline también carga, por orden de prioridad:

- `.puertoline/skills/` y `.claude/skills/` del proyecto.
- `~/.claude/skills/` de Claude Code, si activas el ajuste `includeClaudeSkills`.

Con modelos locales pequeños puedes ahorrar contexto desactivando skills con `disabledSkills`.

## Modelos y respaldo automático

El ajuste `puertoline.models` es una **cadena de modelos en orden de preferencia**. En cada paso el agente usa el primero disponible; si falla, pasa al siguiente y **repite el mismo paso con todo el historial**, así la tarea continúa sin interrupciones:

| Fallo | Qué hace | Pausa del modelo |
|---|---|---|
| Límite de uso (429) | Siguiente modelo | 90 s (o lo que indique `Retry-After`) |
| Sin respuesta / stream cortado | Siguiente modelo | 2 min |
| Error del servidor (5xx) o de red, Ollama apagado | Siguiente modelo | 1–2 min |
| Modelo no soporta herramientas, 404, API key inválida, sin saldo | Siguiente modelo | 1 h |
| La conversación no cabe en su contexto | Siguiente modelo | 10 min |
| **Todos** en pausa | Espera (hasta 60 s) y reintenta | — |

Cuando termina la pausa del modelo principal, el agente vuelve a él automáticamente. El panel muestra el modelo activo y un aviso cada vez que cambia; si un modelo falla a mitad de respuesta, su texto parcial se descarta.

Por defecto la cadena es: `ollama/*` (todos tus modelos locales) → `openrouter/*free*` (todos los gratuitos con herramientas, la lista se consulta en vivo) → Gemini → Groq → Cerebras → Mistral → GitHub Models → DeepSeek. Los proveedores sin API key se omiten solos.

```json
"puertoline.models": [
  { "provider": "ollama", "model": "qwen2.5-coder:7b" },
  { "provider": "openrouter", "model": "*free*" },
  { "provider": "custom", "model": "mi-modelo", "baseUrl": "http://localhost:1234/v1" }
]
```

Con Ollama se usa su API nativa para fijar la ventana de contexto (`ollamaContextLength`, 32k por defecto), ya que su valor por defecto es demasiado pequeño para un agente. Los modelos deben soportar *tool calling* (en Ollama: <https://ollama.com/search?c=tools>).

## Herramientas del agente

| Herramienta | Qué hace | ¿Pide permiso? |
|---|---|---|
| `use_skill` | Cargar una skill y sus archivos de apoyo | No |
| `list_dir`, `find_files`, `search_text`, `read_file` | Explorar y leer el proyecto | No |
| `write_file`, `edit_file` | Crear / editar archivos (abre un diff para revisar) | Sí |
| `run_command` | Ejecutar comandos (PowerShell en Windows) | Sí |
| `http_request` | Llamar a cualquier API REST / webhook | Sí |
| `mcp__<servidor>__<herramienta>` | Herramientas de los servidores MCP conectados | Sí (salvo `"trust": true`) |

El agente solo puede tocar archivos dentro de la carpeta abierta.

## Integraciones: MCP

El agente se conecta como cliente a cualquier servidor [MCP](https://modelcontextprotocol.io) — local (stdio) o remoto (HTTP / SSE) — y usa sus herramientas automáticamente. Lee la configuración, en este orden (la última gana):

1. Ajuste `puertoline.mcpServers` (global, todos los proyectos).
2. `.vscode/mcp.json` del proyecto (formato de VS Code, clave `"servers"`).
3. `.mcp.json` del proyecto (formato de Claude Code, clave `"mcpServers"`).

Así que las configuraciones que ya uses con Claude Code o con VS Code funcionan tal cual.

```json
{
  "mcpServers": {
    "github": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-github"],
      "env": { "GITHUB_PERSONAL_ACCESS_TOKEN": "${env:GITHUB_TOKEN}" }
    },
    "n8n": {
      "type": "http",
      "url": "https://TU-INSTANCIA.app.n8n.cloud/mcp-server/http",
      "headers": { "Authorization": "Bearer ${env:N8N_MCP_TOKEN}" },
      "trust": true
    },
    "playwright": { "command": "npx", "args": ["@playwright/mcp@latest"] }
  }
}
```

- `${env:VAR}` lee variables de entorno (no escribas tokens en claro en archivos que subes a git). `${workspaceFolder}` es la raíz del proyecto.
- `"trust": true` → sus herramientas se ejecutan sin pedir permiso. `"disabled": true` → no se conecta.
- El botón **🔌** del panel muestra el estado de cada servidor; el registro detallado está en *Salida → Puertoline*.
- Los cambios en `.mcp.json` se recargan solos.

Comandos: **Servidores MCP**, **Editar configuración MCP (.mcp.json)** (crea una plantilla), **Reconectar servidores MCP**.

## Ajustes (`Ctrl+,` → "Puertoline")

- `models` — cadena de modelos (ver arriba).
- `timeoutSeconds` / `localTimeoutSeconds` — cuánto esperar antes de pasar al siguiente modelo (nube / Ollama).
- `ollamaContextLength` — ventana de contexto para Ollama.
- `autoApproveEdits` / `autoApproveCommands` / `autoApproveMcp` / `autoApproveHttp` — saltar confirmaciones.
- `mcpServers` — servidores MCP globales.
- `disabledSkills`, `includeClaudeSkills` — control de skills.
- `maxSteps`, `commandTimeoutSeconds`.

## Instrucciones por proyecto

Si la raíz del proyecto contiene `AGENTS.md`, `CLAUDE.md` o `PUERTOLINE.md`, su contenido se añade al prompt del agente (convenciones, comandos de test, etc.).

## Desarrollo

```bash
npm install
npm run compile
```

Pulsa `F5` para lanzar una ventana de VS Code con la extensión cargada. `npm run package` genera el `.vsix`.

**Publicar una versión:** sube `version` en `package.json`, haz commit y luego ejecuta `git tag vX.Y.Z && git push --tags`. GitHub Actions compila el `.vsix` y lo publica en Releases.

## Licencia

MIT. Las skills incluidas conservan la licencia de sus autores (MIT o Apache 2.0); ver [skills/README.md](skills/README.md).
