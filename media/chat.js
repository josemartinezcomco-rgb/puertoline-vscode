// Webview UI for the agent chat.
(function () {
  const vscode = acquireVsCodeApi();
  const $ = (id) => document.getElementById(id);
  const messages = $('messages');
  const input = $('input');
  const sendBtn = $('send');
  const stopBtn = $('stop');
  const status = $('status');

  let current = null; // { el, text, reasoningEl }
  const tools = new Map();
  let busy = false;

  function esc(s) {
    return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  function inline(s) {
    return s
      .replace(/`([^`]+)`/g, '<code>$1</code>')
      .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
      .replace(/(^|[^*])\*([^*\s][^*]*)\*/g, '$1<em>$2</em>')
      .replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<u title="$2">$1</u>');
  }

  // Small Markdown renderer: fenced code, headings, lists, paragraphs, inline styles.
  function markdown(src) {
    const parts = src.split(/```/);
    let html = '';
    parts.forEach((part, i) => {
      if (i % 2 === 1) {
        const nl = part.indexOf('\n');
        const code = nl >= 0 ? part.slice(nl + 1) : part;
        html += `<pre><code>${esc(code.replace(/\n$/, ''))}</code></pre>`;
        return;
      }
      let list = null;
      const close = () => { if (list) { html += `</${list}>`; list = null; } };
      for (const raw of esc(part).split('\n')) {
        const line = raw.trimEnd();
        let m;
        if ((m = line.match(/^(#{1,4})\s+(.*)/))) {
          close();
          const lvl = Math.min(m[1].length + 2, 6);
          html += `<h${lvl}>${inline(m[2])}</h${lvl}>`;
        } else if ((m = line.match(/^\s*[-*]\s+(.*)/))) {
          if (list !== 'ul') { close(); html += '<ul>'; list = 'ul'; }
          html += `<li>${inline(m[1])}</li>`;
        } else if ((m = line.match(/^\s*\d+[.)]\s+(.*)/))) {
          if (list !== 'ol') { close(); html += '<ol>'; list = 'ol'; }
          html += `<li>${inline(m[1])}</li>`;
        } else if (line.trim() === '') {
          close();
        } else {
          close();
          html += `<p>${inline(line)}</p>`;
        }
      }
      close();
    });
    return html;
  }

  function scroll() {
    messages.scrollTop = messages.scrollHeight;
  }

  function add(cls, html) {
    messages.querySelector('.empty')?.remove();
    const el = document.createElement('div');
    el.className = cls;
    el.innerHTML = html;
    messages.appendChild(el);
    scroll();
    return el;
  }

  // Live "Trabajando con X… 12 s" so a slow model never looks frozen.
  let activeModel = '';
  let stepStart = 0;
  let waitingApproval = false;
  let ticker = null;
  function renderStatus() {
    if (!busy || waitingApproval) return;
    const secs = Math.round((Date.now() - stepStart) / 1000);
    status.textContent = `${activeModel ? `Trabajando con ${activeModel}` : 'Trabajando'}… ${secs} s`;
  }

  function setBusy(b) {
    busy = b;
    sendBtn.hidden = b;
    stopBtn.hidden = !b;
    clearInterval(ticker);
    waitingApproval = false;
    if (b) {
      stepStart = Date.now();
      activeModel = '';
      ticker = setInterval(renderStatus, 1000);
      renderStatus();
    } else {
      status.textContent = '';
    }
  }

  function summarizeArgs(name, raw) {
    try {
      const a = JSON.parse(raw || '{}');
      if (name.startsWith('mcp__')) return JSON.stringify(a);
      if (name === 'http_request') return `${a.method || 'GET'} ${a.url || ''}`;
      return a.command || a.path || a.pattern || a.regex || '';
    } catch {
      return '';
    }
  }

  function send() {
    const text = input.value.trim();
    if (!text || busy) return;
    add('msg user', esc(text));
    input.value = '';
    setBusy(true);
    vscode.postMessage({ type: 'send', text });
  }

  // "/skill" autocomplete
  let skills = [];
  let matches = [];
  let active = 0;
  const suggest = $('suggest');

  function renderSuggest() {
    const m = input.value.match(/^\/([\w.-]*)$/);
    matches = m ? skills.filter((s) => s.name.includes(m[1].toLowerCase())).slice(0, 8) : [];
    suggest.hidden = !matches.length;
    active = Math.min(active, Math.max(0, matches.length - 1));
    suggest.innerHTML = matches
      .map((s, i) => `<div class="opt${i === active ? ' active' : ''}" data-i="${i}"><b>/${esc(s.name)}</b> <span>${esc(s.category)}</span><div>${esc(s.description)}</div></div>`)
      .join('');
  }
  function pick(i) {
    input.value = `/${matches[i].name} `;
    suggest.hidden = true;
    input.focus();
  }
  suggest.addEventListener('mousedown', (e) => {
    const opt = e.target.closest('.opt');
    if (opt) { e.preventDefault(); pick(Number(opt.dataset.i)); }
  });
  input.addEventListener('input', () => { active = 0; renderSuggest(); });

  $('composer').addEventListener('submit', (e) => { e.preventDefault(); send(); });
  input.addEventListener('keydown', (e) => {
    if (!suggest.hidden) {
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        active = (active + (e.key === 'ArrowDown' ? 1 : -1) + matches.length) % matches.length;
        renderSuggest();
        return;
      }
      if (e.key === 'Tab' || (e.key === 'Enter' && !e.shiftKey)) { e.preventDefault(); pick(active); return; }
      if (e.key === 'Escape') { suggest.hidden = true; return; }
    }
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); send(); }
  });
  $('skills').addEventListener('click', () => vscode.postMessage({ type: 'skills' }));
  stopBtn.addEventListener('click', () => vscode.postMessage({ type: 'stop' }));
  $('new').addEventListener('click', () => vscode.postMessage({ type: 'newChat' }));
  $('key').addEventListener('click', () => vscode.postMessage({ type: 'setKey' }));
  $('settings').addEventListener('click', () => vscode.postMessage({ type: 'settings' }));
  $('mcp').addEventListener('click', () => vscode.postMessage({ type: 'mcp' }));
  $('model').addEventListener('click', () => vscode.postMessage({ type: 'models' }));

  window.addEventListener('message', (event) => {
    const m = event.data;
    switch (m.type) {
      case 'skills':
        skills = m.skills;
        $('skills').textContent = `📚 ${skills.length}`;
        break;
      case 'model':
        $('model').textContent = `🤖 ${m.id.split('/').slice(1).join('/')}`;
        $('model').title = `Modelo actual: ${m.id}. Pulsa para ver la cadena de respaldo.`;
        activeModel = m.id.split('/').slice(1).join('/');
        stepStart = Date.now();
        waitingApproval = false;
        renderStatus();
        break;
      case 'discard':
        // The model failed mid-answer: drop its partial output, the next model redoes the step.
        if (current) {
          current.reasoningEl?.remove();
          current.el.remove();
          current = null;
        }
        break;
      case 'finalText':
        if (current && current.text !== m.text) {
          current.text = m.text;
          if (m.text.trim()) current.el.innerHTML = markdown(m.text);
          else current.el.remove();
        }
        break;
      case 'notice':
        add('notice', esc(m.message));
        break;
      case 'mcpStatus': {
        const b = $('mcp');
        b.textContent = m.connecting ? '🔌 …' : `🔌 ${m.connected}/${m.total}`;
        b.title = m.total
          ? `Servidores MCP: ${m.connected} de ${m.total} conectados${m.errors ? ' (hay errores)' : ''}`
          : 'Sin servidores MCP. Pulsa para configurar.';
        b.classList.toggle('warn', !!m.errors);
        break;
      }
      case 'assistantStart':
        current = null;
        break;
      case 'reasoning':
        if (!current) current = { el: add('msg assistant', ''), text: '' };
        if (!current.reasoningEl) {
          current.reasoningEl = document.createElement('div');
          current.reasoningEl.className = 'reasoning';
          current.el.before(current.reasoningEl);
        }
        current.reasoningEl.textContent += m.delta;
        current.reasoningEl.scrollTop = current.reasoningEl.scrollHeight;
        scroll();
        break;
      case 'text':
        if (!current) current = { el: add('msg assistant', ''), text: '' };
        current.text += m.delta;
        current.el.innerHTML = markdown(current.text);
        scroll();
        break;
      case 'tool': {
        current = null;
        const el = add('tool', `<details><summary><span class="state"></span><span class="name">${esc(m.name)}</span><span class="arg">${esc(summarizeArgs(m.name, m.args))}</span></summary><pre></pre></details>`);
        tools.set(m.id, el);
        break;
      }
      case 'toolResult': {
        const el = tools.get(m.id);
        if (el) {
          el.classList.add(m.error ? 'err' : 'ok');
          el.querySelector('pre').textContent = m.result;
        }
        break;
      }
      case 'approvalRequest': {
        const icon = { command: '⚡', edit: '✎', mcp: '🔌', http: '🌐' }[m.kind] || '•';
        const el = add('approval', `<div class="title">${icon} ${esc(m.title)}</div><pre>${esc(m.detail)}</pre>${m.kind === 'edit' ? '<div class="verdict">Revisa el diff abierto en el editor.</div>' : ''}<div class="actions"><button class="primary" data-ok="1">Permitir</button><button data-ok="0">Rechazar</button></div>`);
        el.querySelectorAll('button').forEach((b) =>
          b.addEventListener('click', () => {
            const ok = b.dataset.ok === '1';
            vscode.postMessage({ type: 'approval', id: m.id, ok });
            waitingApproval = false;
            stepStart = Date.now();
            el.classList.add('resolved');
            el.insertAdjacentHTML('beforeend', `<div class="verdict">${ok ? '✓ Permitido' : '✕ Rechazado'}</div>`);
          })
        );
        waitingApproval = true;
        status.textContent = '⏸ Esperando tu aprobación (Permitir / Rechazar)…';
        break;
      }
      case 'error':
        add('error', esc(m.message));
        break;
      case 'done':
        current = null;
        setBusy(false);
        input.focus();
        break;
      case 'clear':
        messages.innerHTML = '';
        tools.clear();
        current = null;
        setBusy(false);
        break;
    }
  });

  vscode.postMessage({ type: 'ready' });
})();
