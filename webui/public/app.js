// NanoClaw Web UI — client-side SPA

const API = '/api/v1';
let containerInterval = null;

// --- API helpers ---

async function api(path, opts = {}) {
  const res = await fetch(`${API}${path}`, {
    headers: { 'Content-Type': 'application/json' },
    ...opts,
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: res.statusText }));
    throw new Error(err.error || res.statusText);
  }
  return res.json();
}

function toast(msg) {
  let el = document.getElementById('toast');
  if (!el) {
    el = document.createElement('div');
    el.id = 'toast';
    el.className = 'toast';
    document.body.appendChild(el);
  }
  el.textContent = msg;
  el.classList.add('show');
  setTimeout(() => el.classList.remove('show'), 2500);
}

function h(tag, attrs = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'onclick') el.addEventListener('click', v);
    else if (k === 'className') el.className = v;
    else el.setAttribute(k, v);
  }
  for (const child of children) {
    if (typeof child === 'string') el.appendChild(document.createTextNode(child));
    else if (child) el.appendChild(child);
  }
  return el;
}

// --- Router ---

function navigate(hash) {
  window.location.hash = hash;
}

async function route() {
  if (containerInterval) { clearInterval(containerInterval); containerInterval = null; }

  const hash = window.location.hash.slice(1) || '/';
  const content = document.getElementById('content');
  content.innerHTML = '<p>Loading...</p>';

  try {
    if (hash === '/') await renderDashboard(content);
    else if (hash === '/prompts/global') await renderGlobalPrompts(content);
    else if (hash.match(/^\/groups\/([^/]+)$/)) await renderGroupDetail(content, hash.match(/^\/groups\/([^/]+)$/)[1]);
    else if (hash.match(/^\/tasks\/([^/]+)$/)) await renderTaskDetail(content, hash.match(/^\/tasks\/([^/]+)$/)[1]);
    else content.innerHTML = '<h2>Not found</h2>';
  } catch (err) {
    content.innerHTML = `<div class="card"><p style="color:var(--danger)">Error: ${err.message}</p></div>`;
  }

  // Update active nav
  document.querySelectorAll('#sidebar a').forEach(a => {
    a.classList.toggle('active', a.getAttribute('href') === '#' + hash);
  });
}

// --- Views ---

async function renderDashboard(el) {
  const [groups, containers, health] = await Promise.all([
    api('/groups'),
    api('/containers').catch(() => []),
    api('/health'),
  ]);

  el.innerHTML = '';
  el.appendChild(h('h2', {}, 'Dashboard'));

  // Health
  el.appendChild(h('div', { className: 'card' },
    h('strong', {}, 'Status: '), health.status,
    h('span', { style: 'margin-left:1rem;color:var(--text-muted)' }, `Uptime: ${formatUptime(health.uptime)}`),
  ));

  // Active containers
  el.appendChild(h('h3', {}, `Active Containers (${containers.length})`));
  if (containers.length) {
    const table = h('table', {},
      h('thead', {}, h('tr', {},
        h('th', {}, 'Name'), h('th', {}, 'Group'), h('th', {}, 'Status'), h('th', {}, 'Running For'),
      )),
      h('tbody', {}, ...containers.map(c =>
        h('tr', {},
          h('td', {}, c.name), h('td', {}, c.group),
          h('td', {}, c.status), h('td', {}, c.runningFor),
        ),
      )),
    );
    el.appendChild(h('div', { className: 'card' }, table));
  } else {
    el.appendChild(h('div', { className: 'card' }, h('p', { style: 'color:var(--text-muted)' }, 'No active containers')));
  }
  // Auto-refresh containers every 5s
  containerInterval = setInterval(async () => {
    try {
      const c = await api('/containers');
      const tbody = el.querySelector('tbody');
      if (tbody && c.length) {
        tbody.innerHTML = '';
        c.forEach(cont => tbody.appendChild(
          h('tr', {},
            h('td', {}, cont.name), h('td', {}, cont.group),
            h('td', {}, cont.status), h('td', {}, cont.runningFor),
          ),
        ));
      }
    } catch { /* ignore */ }
  }, 5000);

  // Groups
  el.appendChild(h('h3', {}, 'Groups'));
  const table = h('table', {},
    h('thead', {}, h('tr', {},
      h('th', {}, 'Name'), h('th', {}, 'Folder'), h('th', {}, 'Model'), h('th', {}, 'Main'),
    )),
    h('tbody', {}, ...groups.map(g =>
      h('tr', { onclick: () => navigate(`/groups/${g.folder}`), style: 'cursor:pointer' },
        h('td', {}, g.name), h('td', {}, g.folder),
        h('td', {}, g.model || '-'),
        h('td', {}, g.isMain ? 'Yes' : ''),
      ),
    )),
  );
  el.appendChild(h('div', { className: 'card' }, table));

  updateGroupNav(groups);
}

async function renderGlobalPrompts(el) {
  const prompts = await api('/prompts/global');

  el.innerHTML = '';
  el.appendChild(h('h2', {}, 'Global Prompts'));

  // CLAUDE.md
  el.appendChild(h('h3', {}, 'CLAUDE.md'));
  const claudeArea = h('textarea', { id: 'claude-editor' }, prompts.claude);
  el.appendChild(claudeArea);

  // OLLAMA.md
  el.appendChild(h('h3', {}, 'OLLAMA.md'));
  const ollamaArea = h('textarea', { id: 'ollama-editor' }, prompts.ollama || '');
  el.appendChild(ollamaArea);

  el.appendChild(h('button', {
    className: 'btn btn-primary',
    onclick: async () => {
      await api('/prompts/global', {
        method: 'PUT',
        body: {
          claude: claudeArea.value,
          ollama: ollamaArea.value || undefined,
        },
      });
      toast('Global prompts saved');
    },
  }, 'Save'));
}

async function renderGroupDetail(el, folder) {
  const [group, prompts, tasks] = await Promise.all([
    api(`/groups/${folder}`),
    api(`/groups/${folder}/prompts`),
    api(`/groups/${folder}/tasks`),
  ]);

  el.innerHTML = '';
  el.appendChild(h('h2', {}, group.name));
  if (group.isMain) el.appendChild(h('span', { className: 'badge badge-active', style: 'margin-bottom:1rem;display:inline-block' }, 'Main'));

  // Settings
  el.appendChild(h('h3', {}, 'Settings'));
  const card = h('div', { className: 'card' });
  const modelInput = h('input', { type: 'text', value: group.model || '', placeholder: 'e.g. sonnet, ollama:qwen3' });
  const roundsInput = h('input', { type: 'number', value: group.maxToolRounds ?? '' });
  const timeoutInput = h('input', { type: 'number', value: group.timeoutMs ?? '' });
  card.appendChild(h('div', { className: 'grid-2' },
    h('div', { className: 'form-row' }, h('label', {}, 'Model'), modelInput),
    h('div', { className: 'form-row' }, h('label', {}, 'Max Tool Rounds'), roundsInput),
  ));
  card.appendChild(h('div', { className: 'form-row' }, h('label', {}, 'Timeout (ms)'), timeoutInput));
  card.appendChild(h('button', {
    className: 'btn btn-primary btn-sm',
    onclick: async () => {
      const body = {};
      if (modelInput.value) body.model = modelInput.value;
      if (roundsInput.value) body.maxToolRounds = parseInt(roundsInput.value, 10);
      if (timeoutInput.value) body.timeoutMs = parseInt(timeoutInput.value, 10);
      await api(`/groups/${folder}`, { method: 'PATCH', body });
      toast('Group settings saved');
    },
  }, 'Save Settings'));
  el.appendChild(card);

  // Prompts
  el.appendChild(h('h3', {}, 'CLAUDE.md'));
  const claudeArea = h('textarea', {}, prompts.claude);
  el.appendChild(claudeArea);

  el.appendChild(h('h3', {}, 'OLLAMA.md'));
  const ollamaArea = h('textarea', {}, prompts.ollama || '');
  el.appendChild(ollamaArea);

  el.appendChild(h('button', {
    className: 'btn btn-primary',
    style: 'margin-bottom:1.5rem',
    onclick: async () => {
      await api(`/groups/${folder}/prompts`, {
        method: 'PUT',
        body: {
          claude: claudeArea.value,
          ollama: ollamaArea.value || undefined,
        },
      });
      toast('Prompts saved');
    },
  }, 'Save Prompts'));

  // Tasks
  el.appendChild(h('h3', {}, 'Scheduled Tasks'));
  if (tasks.length) {
    const table = h('table', {},
      h('thead', {}, h('tr', {},
        h('th', {}, 'Prompt'), h('th', {}, 'Schedule'), h('th', {}, 'Status'), h('th', {}, 'Next Run'),
      )),
      h('tbody', {}, ...tasks.map(t =>
        h('tr', { onclick: () => navigate(`/tasks/${t.id}`), style: 'cursor:pointer' },
          h('td', {}, t.prompt.slice(0, 60) + (t.prompt.length > 60 ? '...' : '')),
          h('td', { style: 'font-family:var(--font-mono);font-size:0.8rem' }, t.scheduleValue),
          h('td', {}, statusBadge(t.status)),
          h('td', {}, t.nextRun ? new Date(t.nextRun).toLocaleString() : '-'),
        ),
      )),
    );
    el.appendChild(h('div', { className: 'card' }, table));
  } else {
    el.appendChild(h('div', { className: 'card' }, h('p', { style: 'color:var(--text-muted)' }, 'No scheduled tasks')));
  }
}

async function renderTaskDetail(el, id) {
  const [task, runs] = await Promise.all([
    api(`/tasks/${id}`),
    api(`/tasks/${id}/runs?limit=20`),
  ]);

  el.innerHTML = '';
  el.appendChild(h('h2', {}, 'Task'));
  el.appendChild(h('p', { style: 'color:var(--text-muted);margin-bottom:1rem' }, `ID: ${task.id}`));

  // Prompt editor
  el.appendChild(h('h3', {}, 'Prompt'));
  const promptArea = h('textarea', { style: 'min-height:150px' }, task.prompt);
  el.appendChild(promptArea);

  // Settings form
  el.appendChild(h('h3', {}, 'Settings'));
  const card = h('div', { className: 'card' });
  const schedType = h('input', { type: 'text', value: task.scheduleType });
  const schedVal = h('input', { type: 'text', value: task.scheduleValue });
  const model = h('input', { type: 'text', value: task.model || '' });
  const tz = h('input', { type: 'text', value: task.timezone || '' });
  const rounds = h('input', { type: 'number', value: task.maxToolRounds ?? '' });
  const timeout = h('input', { type: 'number', value: task.timeoutMs ?? '' });
  const status = h('select', {},
    h('option', { value: 'active', ...(task.status === 'active' ? { selected: 'selected' } : {}) }, 'Active'),
    h('option', { value: 'paused', ...(task.status === 'paused' ? { selected: 'selected' } : {}) }, 'Paused'),
  );

  card.appendChild(h('div', { className: 'grid-2' },
    h('div', { className: 'form-row' }, h('label', {}, 'Schedule Type'), schedType),
    h('div', { className: 'form-row' }, h('label', {}, 'Schedule Value'), schedVal),
  ));
  card.appendChild(h('div', { className: 'grid-2' },
    h('div', { className: 'form-row' }, h('label', {}, 'Model'), model),
    h('div', { className: 'form-row' }, h('label', {}, 'Timezone'), tz),
  ));
  card.appendChild(h('div', { className: 'grid-2' },
    h('div', { className: 'form-row' }, h('label', {}, 'Max Tool Rounds'), rounds),
    h('div', { className: 'form-row' }, h('label', {}, 'Timeout (ms)'), timeout),
  ));
  card.appendChild(h('div', { className: 'form-row' }, h('label', {}, 'Status'), status));

  card.appendChild(h('button', {
    className: 'btn btn-primary btn-sm',
    onclick: async () => {
      const body = { prompt: promptArea.value };
      if (schedType.value) body.scheduleType = schedType.value;
      if (schedVal.value) body.scheduleValue = schedVal.value;
      if (model.value) body.model = model.value;
      if (tz.value) body.timezone = tz.value;
      if (rounds.value) body.maxToolRounds = parseInt(rounds.value, 10);
      if (timeout.value) body.timeoutMs = parseInt(timeout.value, 10);
      body.status = status.value;
      await api(`/tasks/${id}`, { method: 'PATCH', body });
      toast('Task saved');
    },
  }, 'Save'));
  el.appendChild(card);

  // Context mode (read-only)
  el.appendChild(h('p', { style: 'color:var(--text-muted);font-size:0.8rem;margin:0.5rem 0' },
    `Context mode: ${task.contextMode} (read-only)`));

  // Run history
  el.appendChild(h('h3', {}, 'Recent Runs'));
  if (runs.length) {
    const table = h('table', {},
      h('thead', {}, h('tr', {},
        h('th', {}, 'Run At'), h('th', {}, 'Duration'), h('th', {}, 'Status'), h('th', {}, 'Result'),
      )),
      h('tbody', {}, ...runs.map(r =>
        h('tr', {},
          h('td', {}, new Date(r.runAt).toLocaleString()),
          h('td', {}, `${(r.durationMs / 1000).toFixed(1)}s`),
          h('td', {}, statusBadge(r.status)),
          h('td', {}, (r.result || r.error || '-').slice(0, 80)),
        ),
      )),
    );
    el.appendChild(h('div', { className: 'card' }, table));
  } else {
    el.appendChild(h('div', { className: 'card' }, h('p', { style: 'color:var(--text-muted)' }, 'No runs yet')));
  }
}

// --- Helpers ---

function updateGroupNav(groups) {
  const nav = document.getElementById('group-nav');
  nav.innerHTML = '';
  groups.forEach(g => {
    nav.appendChild(h('li', {},
      h('a', { href: `#/groups/${g.folder}` }, g.name),
    ));
  });
}

function statusBadge(status) {
  const cls = status === 'active' ? 'badge-active'
    : status === 'paused' ? 'badge-paused'
    : status === 'success' ? 'badge-success'
    : status === 'error' ? 'badge-error'
    : '';
  return h('span', { className: `badge ${cls}` }, status);
}

function formatUptime(seconds) {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m`;
}

// Load group nav on startup
api('/groups').then(updateGroupNav).catch(() => {});

// Start router
window.addEventListener('hashchange', route);
route();
