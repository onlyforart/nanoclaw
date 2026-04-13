// NanoClaw Web UI — Vue 3 + TailwindCSS (CDN)

const { createApp, ref, computed, watch, onMounted, onUnmounted, nextTick } = Vue;

// ── API Layer ──────────────────────────────────────────────

const API = '/api/v1';

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

// ── Toast State ────────────────────────────────────────────

const toasts = Vue.reactive([]);
let toastId = 0;

function showToast(msg, type = 'success') {
  const id = ++toastId;
  toasts.push({ id, msg, type, leaving: false });
  setTimeout(() => {
    const t = toasts.find(t => t.id === id);
    if (t) t.leaving = true;
    setTimeout(() => {
      const idx = toasts.findIndex(t => t.id === id);
      if (idx !== -1) toasts.splice(idx, 1);
    }, 300);
  }, 2500);
}

// ── Helpers ────────────────────────────────────────────────

function formatUptime(s) {
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  return h > 0 ? `${h}h ${m}m` : `${m}m`;
}

function validateSchedule(type, value) {
  const v = value.trim();
  if (!v) return '';
  if (type === 'cron') {
    const fields = v.split(/\s+/);
    if (fields.length !== 5) return `Cron requires exactly 5 fields (minute hour day month weekday), got ${fields.length}`;
    const names = ['minute', 'hour', 'day', 'month', 'weekday'];
    for (let i = 0; i < 5; i++) {
      const f = fields[i];
      if (f === '*') continue;
      if (/^(\*\/\d+|\d+(-\d+)?(\/\d+)?(,\d+(-\d+)?(\/\d+)?)*)$/.test(f)) continue;
      return `Invalid ${names[i]} field: "${f}"`;
    }
    return '';
  }
  if (type === 'interval') {
    const ms = parseInt(v, 10);
    if (isNaN(ms) || ms <= 0) return 'Interval must be a positive number (milliseconds)';
    return '';
  }
  if (type === 'once') {
    if (isNaN(new Date(v).getTime())) return 'Could not parse date \u2014 try "June 1 2026 9am" or "2026-06-01T09:00"';
    return '';
  }
  return '';
}

function scheduleHintText(type, value) {
  const v = value.trim();
  if (!v || validateSchedule(type, value)) return '';
  if (type === 'cron') return 'Format: minute hour day month weekday';
  if (type === 'interval') {
    const ms = parseInt(v, 10);
    if (ms >= 3600000) return `Every ${(ms / 3600000).toFixed(1)} hour(s)`;
    if (ms >= 60000) return `Every ${(ms / 60000).toFixed(0)} minute(s)`;
    return `Every ${(ms / 1000).toFixed(0)} second(s)`;
  }
  if (type === 'once') {
    const d = new Date(v);
    return `Will run at: ${d.toLocaleString()} \u2014 ${d.toISOString()}`;
  }
  return '';
}

function normalizeScheduleValue(type, value) {
  if (type === 'once') return new Date(value).toISOString();
  return value;
}

// ── Icons (inline SVG paths) ───────────────────────────────

const icons = {
  dashboard: '<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 6a2 2 0 012-2h2a2 2 0 012 2v2a2 2 0 01-2 2H6a2 2 0 01-2-2V6zm10 0a2 2 0 012-2h2a2 2 0 012 2v2a2 2 0 01-2 2h-2a2 2 0 01-2-2V6zM4 16a2 2 0 012-2h2a2 2 0 012 2v2a2 2 0 01-2 2H6a2 2 0 01-2-2v-2zm10 0a2 2 0 012-2h2a2 2 0 012 2v2a2 2 0 01-2 2h-2a2 2 0 01-2-2v-2z"/>',
  prompts: '<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z"/>',
  group: '<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M17 20h5v-2a3 3 0 00-5.356-1.857M17 20H7m10 0v-2c0-.656-.126-1.283-.356-1.857M7 20H2v-2a3 3 0 015.356-1.857M7 20v-2c0-.656.126-1.283.356-1.857m0 0a5.002 5.002 0 019.288 0M15 7a3 3 0 11-6 0 3 3 0 016 0z"/>',
  sun: '<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 3v1m0 16v1m9-9h-1M4 12H3m15.364 6.364l-.707-.707M6.343 6.343l-.707-.707m12.728 0l-.707.707M6.343 17.657l-.707.707M16 12a4 4 0 11-8 0 4 4 0 018 0z"/>',
  moon: '<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M20.354 15.354A9 9 0 018.646 3.646 9.003 9.003 0 0012 21a9.003 9.003 0 008.354-5.646z"/>',
  menu: '<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 6h16M4 12h16M4 18h16"/>',
  close: '<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 18L18 6M6 6l12 12"/>',
  back: '<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M10 19l-7-7m0 0l7-7m-7 7h18"/>',
  list: '<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 6h16M4 10h16M4 14h16M4 18h16"/>',
};

// ── Components ─────────────────────────────────────────────

// Status Badge
const StatusBadge = {
  props: ['status'],
  template: `
    <span :class="classes" class="inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-semibold uppercase tracking-wide">
      {{ status }}
    </span>
  `,
  setup(props) {
    const classes = computed(() => {
      switch (props.status) {
        case 'active': case 'success':
          return 'bg-emerald-100 text-emerald-800 dark:bg-emerald-900/50 dark:text-emerald-300';
        case 'paused':
          return 'bg-amber-100 text-amber-800 dark:bg-amber-900/50 dark:text-amber-300';
        case 'error':
          return 'bg-red-100 text-red-800 dark:bg-red-900/50 dark:text-red-300';
        default:
          return 'bg-gray-100 text-gray-800 dark:bg-gray-700 dark:text-gray-300';
      }
    });
    return { classes };
  },
};

// Tab Bar
const TabBar = {
  props: ['tabs', 'active'],
  emits: ['select'],
  template: `
    <div class="border-b border-gray-200 dark:border-gray-700 mb-6">
      <nav class="flex gap-0" aria-label="Tabs">
        <button v-for="tab in tabs" :key="tab.key"
          @click="$emit('select', tab.key)"
          :class="[
            tab.key === active
              ? 'border-blue-500 text-blue-600 dark:text-blue-400'
              : 'border-transparent text-gray-500 hover:text-gray-700 hover:border-gray-300 dark:text-gray-400 dark:hover:text-gray-300',
            'px-4 py-3 text-sm font-medium border-b-2 transition-colors whitespace-nowrap'
          ]">
          {{ tab.label }}
          <span v-if="tab.count != null"
            class="ml-1.5 px-1.5 py-0.5 rounded-full text-xs"
            :class="tab.key === active
              ? 'bg-blue-100 text-blue-600 dark:bg-blue-900/50 dark:text-blue-300'
              : 'bg-gray-100 text-gray-500 dark:bg-gray-700 dark:text-gray-400'">
            {{ tab.count }}
          </span>
        </button>
      </nav>
    </div>
  `,
};

// Toast
const AppToast = {
  template: `
    <div class="fixed bottom-6 right-6 z-50 flex flex-col gap-2">
      <div v-for="t in toasts" :key="t.id"
        :class="[
          t.leaving ? 'toast-leave' : 'toast-enter',
          t.type === 'error'
            ? 'bg-red-600'
            : 'bg-emerald-600'
        ]"
        class="text-white px-4 py-2.5 rounded-lg shadow-lg text-sm font-medium">
        {{ t.msg }}
      </div>
    </div>
  `,
  setup() {
    return { toasts };
  },
};

// Sidebar
const AppSidebar = {
  props: ['groups', 'currentHash', 'activeGroupFolder', 'open', 'darkMode'],
  emits: ['toggle', 'toggleDark'],
  template: `
    <!-- Mobile overlay -->
    <div v-if="open" @click="$emit('toggle')"
      class="fixed inset-0 bg-black/50 z-40 md:hidden"></div>

    <!-- Sidebar -->
    <aside :class="[open ? 'translate-x-0' : '-translate-x-full md:translate-x-0']"
      class="fixed md:sticky top-0 z-50 md:z-auto w-64 h-screen bg-gray-900 dark:bg-gray-950 text-gray-400 flex flex-col transition-transform duration-200 sidebar-scroll overflow-y-auto shrink-0">

      <!-- Header -->
      <div class="px-5 py-5 flex items-center justify-between">
        <a href="#/" class="text-lg font-bold text-white tracking-tight">NanoClaw</a>
        <button @click="$emit('toggle')" class="md:hidden text-gray-400 hover:text-white">
          <svg class="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">${icons.close}</svg>
        </button>
      </div>

      <!-- Nav -->
      <nav class="flex-1 px-3 space-y-1">
        <a href="#/"
          :class="isActive('/') ? 'bg-gray-800 text-white border-l-3 border-blue-500' : 'hover:bg-white/10 hover:text-gray-200 border-l-3 border-transparent'"
          class="flex items-center gap-3 px-3 py-2 rounded-r-lg text-sm font-medium transition-colors">
          <svg class="w-5 h-5 shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">${icons.dashboard}</svg>
          Dashboard
        </a>
        <a href="#/prompts/global"
          :class="isActive('/prompts/global') ? 'bg-gray-800 text-white border-l-3 border-blue-500' : 'hover:bg-white/10 hover:text-gray-200 border-l-3 border-transparent'"
          class="flex items-center gap-3 px-3 py-2 rounded-r-lg text-sm font-medium transition-colors">
          <svg class="w-5 h-5 shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">${icons.prompts}</svg>
          Global Prompts
        </a>
        <a href="#/observations"
          :class="isActive('/observations') ? 'bg-gray-800 text-white border-l-3 border-blue-500' : 'hover:bg-white/10 hover:text-gray-200 border-l-3 border-transparent'"
          class="flex items-center gap-3 px-3 py-2 rounded-r-lg text-sm font-medium transition-colors">
          <svg class="w-5 h-5 shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">${icons.prompts}</svg>
          Observations
        </a>
        <a href="#/events"
          :class="isActive('/events') ? 'bg-gray-800 text-white border-l-3 border-blue-500' : 'hover:bg-white/10 hover:text-gray-200 border-l-3 border-transparent'"
          class="flex items-center gap-3 px-3 py-2 rounded-r-lg text-sm font-medium transition-colors">
          <svg class="w-5 h-5 shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">${icons.list}</svg>
          Events
        </a>
        <a href="#/pipeline"
          :class="isActive('/pipeline') ? 'bg-gray-800 text-white border-l-3 border-blue-500' : 'hover:bg-white/10 hover:text-gray-200 border-l-3 border-transparent'"
          class="flex items-center gap-3 px-3 py-2 rounded-r-lg text-sm font-medium transition-colors">
          <svg class="w-5 h-5 shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">${icons.dashboard}</svg>
          Pipeline
        </a>

        <!-- Groups section -->
        <div class="pt-5 pb-2">
          <div class="flex items-center justify-between px-3">
            <span class="text-xs font-semibold uppercase tracking-wider text-gray-500">Groups</span>
            <span v-if="groups.length" class="text-xs px-1.5 py-0.5 rounded-full bg-gray-800 text-gray-400">
              {{ groups.length }}
            </span>
          </div>
        </div>
        <a v-for="g in groups" :key="g.folder"
          :href="'#/groups/' + g.folder"
          :class="isActive('/groups/' + g.folder) ? 'bg-gray-800 text-white border-l-3 border-blue-500' : 'hover:bg-white/10 hover:text-gray-200 border-l-3 border-transparent'"
          class="flex items-center gap-3 px-3 py-2 rounded-r-lg text-sm transition-colors">
          <svg class="w-4 h-4 shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">${icons.group}</svg>
          <span class="truncate">{{ g.name }}</span>
          <span v-if="g.isMain" class="ml-auto text-[10px] px-1.5 py-0.5 rounded bg-blue-500/20 text-blue-400 font-medium">MAIN</span>
        </a>
      </nav>

      <!-- Footer -->
      <div class="px-5 py-4 border-t border-gray-800">
        <button @click="$emit('toggleDark')"
          class="flex items-center gap-2 text-sm text-gray-500 hover:text-gray-300 transition-colors">
          <svg v-if="darkMode" class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">${icons.sun}</svg>
          <svg v-else class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">${icons.moon}</svg>
          {{ darkMode ? 'Light mode' : 'Dark mode' }}
        </button>
      </div>
    </aside>
  `,
  setup(props) {
    const isActive = (path) => {
      if (props.currentHash === path || props.currentHash.startsWith(path + '/')) return true;
      if (props.activeGroupFolder && path === '/groups/' + props.activeGroupFolder) return true;
      // Pipeline task detail → highlight Pipeline link
      if (path === '/pipeline' && props.currentHash.startsWith('/tasks/pipeline:')) return true;
      return false;
    };
    return { isActive };
  },
};

// Dashboard
const AppDashboard = {
  props: ['groups'],
  template: `
    <div>
      <h2 class="text-2xl font-bold mb-6">Dashboard</h2>

      <!-- Health -->
      <div v-if="health" class="bg-white dark:bg-gray-800 rounded-xl border border-gray-200 dark:border-gray-700 p-5 mb-6">
        <div class="flex items-center gap-3">
          <span class="flex h-3 w-3 relative">
            <span class="animate-ping absolute inline-flex h-full w-full rounded-full bg-emerald-400 opacity-75"></span>
            <span class="relative inline-flex rounded-full h-3 w-3 bg-emerald-500"></span>
          </span>
          <span class="font-semibold text-emerald-600 dark:text-emerald-400">Healthy</span>
          <span class="text-gray-400 text-sm ml-4">Uptime: {{ formatUptime(health.uptime) }}</span>
        </div>
      </div>

      <!-- Containers -->
      <h3 class="text-lg font-semibold mb-3 flex items-center gap-2">
        Active Containers
        <span class="text-xs px-2 py-0.5 rounded-full bg-gray-100 dark:bg-gray-700 text-gray-500 dark:text-gray-400 font-normal">
          {{ containers.length }}
        </span>
      </h3>
      <div class="bg-white dark:bg-gray-800 rounded-xl border border-gray-200 dark:border-gray-700 overflow-hidden mb-8">
        <table v-if="containers.length" class="w-full text-sm">
          <thead>
            <tr class="border-b border-gray-200 dark:border-gray-700">
              <th class="text-left px-4 py-3 text-xs font-semibold uppercase tracking-wider text-gray-500 dark:text-gray-400">Name</th>
              <th class="text-left px-4 py-3 text-xs font-semibold uppercase tracking-wider text-gray-500 dark:text-gray-400">Group</th>
              <th class="text-left px-4 py-3 text-xs font-semibold uppercase tracking-wider text-gray-500 dark:text-gray-400">Status</th>
              <th class="text-left px-4 py-3 text-xs font-semibold uppercase tracking-wider text-gray-500 dark:text-gray-400">Running For</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="c in containers" :key="c.name" class="border-b border-gray-100 dark:border-gray-700/50 last:border-0">
              <td class="px-4 py-3 font-mono text-xs">{{ c.name }}</td>
              <td class="px-4 py-3">{{ c.group }}</td>
              <td class="px-4 py-3">{{ c.status }}</td>
              <td class="px-4 py-3 text-gray-500">{{ c.runningFor }}</td>
            </tr>
          </tbody>
        </table>
        <p v-else class="px-4 py-8 text-center text-gray-400 text-sm">No active containers</p>
      </div>

      <!-- Groups -->
      <h3 class="text-lg font-semibold mb-3">Groups</h3>
      <div class="bg-white dark:bg-gray-800 rounded-xl border border-gray-200 dark:border-gray-700 overflow-hidden">
        <table v-if="groups.length" class="w-full text-sm">
          <thead>
            <tr class="border-b border-gray-200 dark:border-gray-700">
              <th class="text-left px-4 py-3 text-xs font-semibold uppercase tracking-wider text-gray-500 dark:text-gray-400">Name</th>
              <th class="text-left px-4 py-3 text-xs font-semibold uppercase tracking-wider text-gray-500 dark:text-gray-400">Folder</th>
              <th class="text-left px-4 py-3 text-xs font-semibold uppercase tracking-wider text-gray-500 dark:text-gray-400">Model</th>
              <th class="text-left px-4 py-3 text-xs font-semibold uppercase tracking-wider text-gray-500 dark:text-gray-400"></th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="g in groups" :key="g.folder" @click="navigate('/groups/' + g.folder)"
              class="border-b border-gray-100 dark:border-gray-700/50 last:border-0 cursor-pointer hover:bg-gray-50 dark:hover:bg-gray-700/50 transition-colors">
              <td class="px-4 py-3 font-medium">{{ g.name }}</td>
              <td class="px-4 py-3 font-mono text-xs text-gray-500">{{ g.folder }}</td>
              <td class="px-4 py-3 text-gray-500">{{ g.model || '—' }}</td>
              <td class="px-4 py-3">
                <span v-if="g.isMain" class="text-[10px] px-2 py-0.5 rounded-full bg-blue-100 dark:bg-blue-900/50 text-blue-700 dark:text-blue-300 font-semibold uppercase">Main</span>
              </td>
            </tr>
          </tbody>
        </table>
        <p v-else class="px-4 py-8 text-center text-gray-400 text-sm">No groups registered</p>
      </div>
    </div>
  `,
  setup() {
    const health = ref(null);
    const containers = ref([]);
    let interval = null;

    const fetchContainers = async () => {
      try { containers.value = await api('/containers'); } catch {}
    };

    const fetchHealth = async () => {
      try { health.value = await api('/health'); } catch {}
    };

    const fetchAll = async () => {
      await Promise.all([fetchHealth(), fetchContainers()]);
    };

    onMounted(async () => {
      await fetchAll();
      interval = setInterval(fetchAll, 5000);
    });

    onUnmounted(() => { if (interval) clearInterval(interval); });

    const navigate = (path) => { window.location.hash = path; };

    return { health, containers, formatUptime, navigate };
  },
};

// Global Prompts
const AppGlobalPrompts = {
  template: `
    <div>
      <div class="flex items-center justify-between mb-6">
        <h2 class="text-2xl font-bold">Global Prompts</h2>
        <div class="flex items-center gap-2">
          <input v-model="newChannel" type="text" placeholder="channel name"
            @keydown.enter="addOverride"
            class="w-32 px-2 py-1.5 rounded border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-800 text-sm focus:ring-2 focus:ring-blue-500 focus:border-blue-500 outline-none transition">
          <button @click="addOverride" :disabled="!newChannel.trim()"
            class="px-3 py-1.5 bg-gray-600 hover:bg-gray-500 disabled:opacity-30 text-white rounded text-sm font-medium transition-colors">
            Add Channel
          </button>
        </div>
      </div>

      <div v-if="loading" class="text-gray-400 text-sm">Loading...</div>
      <div v-else>
        <tab-bar :tabs="tabs" :active="activeTab" @select="activeTab = $event" />

        <!-- Global tab -->
        <div v-if="activeTab === 'global'">
          <div class="mb-6">
            <label class="block text-sm font-medium mb-2">CLAUDE.md</label>
            <textarea v-model="claude"
              class="w-full h-72 px-4 py-3 rounded-lg border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-800 font-mono text-sm leading-relaxed resize-y focus:ring-2 focus:ring-blue-500 focus:border-blue-500 outline-none transition"></textarea>
          </div>
          <div class="mb-6">
            <label class="block text-sm font-medium mb-2">OLLAMA.md</label>
            <textarea v-model="ollama"
              class="w-full h-48 px-4 py-3 rounded-lg border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-800 font-mono text-sm leading-relaxed resize-y focus:ring-2 focus:ring-blue-500 focus:border-blue-500 outline-none transition"></textarea>
          </div>
        </div>

        <!-- Channel override tabs -->
        <div v-for="(content, channel) in channelOverrides" :key="channel"
          v-show="activeTab === channel">
          <div class="mb-3">
            <p class="text-sm text-gray-400">System prompt override for <span class="font-mono font-medium text-gray-300">{{ channel }}_*</span> groups. Appended after the global prompt.</p>
          </div>
          <div class="mb-6">
            <label class="block text-sm font-medium mb-2 font-mono">{{ channel.toUpperCase() }}.md</label>
            <textarea v-model="channelOverrides[channel]"
              class="w-full h-72 px-4 py-3 rounded-lg border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-800 font-mono text-sm leading-relaxed resize-y focus:ring-2 focus:ring-blue-500 focus:border-blue-500 outline-none transition"></textarea>
          </div>
        </div>

        <button @click="save" :disabled="saving"
          class="px-4 py-2 bg-blue-600 hover:bg-blue-700 disabled:opacity-50 text-white rounded-lg text-sm font-medium transition-colors">
          {{ saving ? 'Saving...' : 'Save' }}
        </button>
      </div>
    </div>
  `,
  setup() {
    const claude = ref('');
    const ollama = ref('');
    const channelOverrides = Vue.reactive({});
    const newChannel = ref('');
    const activeTab = ref('global');
    const loading = ref(true);
    const saving = ref(false);

    const tabs = computed(() => {
      const t = [{ key: 'global', label: 'Global' }];
      for (const ch of Object.keys(channelOverrides).sort()) {
        t.push({ key: ch, label: ch.charAt(0).toUpperCase() + ch.slice(1) });
      }
      return t;
    });

    onMounted(async () => {
      try {
        const data = await api('/prompts/global');
        claude.value = data.claude;
        ollama.value = data.ollama || '';
        if (data.channelOverrides) {
          Object.assign(channelOverrides, data.channelOverrides);
        }
      } catch (e) { showToast(e.message, 'error'); }
      loading.value = false;
    });

    const addOverride = () => {
      const ch = newChannel.value.trim().toLowerCase().replace(/[^a-z]/g, '');
      if (!ch || channelOverrides[ch] !== undefined) return;
      channelOverrides[ch] = '';
      newChannel.value = '';
      activeTab.value = ch;
    };

    const save = async () => {
      saving.value = true;
      try {
        await api('/prompts/global', {
          method: 'PUT',
          body: {
            claude: claude.value,
            ollama: ollama.value || undefined,
            channelOverrides,
          },
        });
        showToast('Global prompts saved');
      } catch (e) { showToast(e.message, 'error'); }
      saving.value = false;
    };

    return { claude, ollama, channelOverrides, newChannel, activeTab, tabs, loading, saving, save, addOverride };
  },
};

// Group Detail (Tabbed)
const AppGroupDetail = {
  props: ['folder', 'initialTab'],
  template: `
    <div>
      <!-- Header -->
      <div class="flex items-center gap-3 mb-1">
        <h2 class="text-2xl font-bold">{{ group ? group.name : folder }}</h2>
        <span v-if="group && group.isMain" class="text-[10px] px-2 py-0.5 rounded-full bg-blue-100 dark:bg-blue-900/50 text-blue-700 dark:text-blue-300 font-semibold uppercase">Main</span>
      </div>
      <p class="text-sm text-gray-400 mb-6 font-mono">{{ folder }}</p>

      <div v-if="loading" class="text-gray-400 text-sm">Loading...</div>
      <div v-else>
        <tab-bar :tabs="tabs" :active="activeTab" @select="selectTab" />

        <!-- Settings Tab -->
        <div v-if="activeTab === 'settings'">
          <div class="bg-white dark:bg-gray-800 rounded-xl border border-gray-200 dark:border-gray-700 p-6">
            <div class="grid grid-cols-1 md:grid-cols-2 gap-4 mb-4">
              <div>
                <label class="block text-sm font-medium mb-1">Model</label>
                <input v-model="form.model" type="text" placeholder="e.g. sonnet, ollama:qwen3"
                  class="w-full px-3 py-2 rounded-lg border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-800 text-sm focus:ring-2 focus:ring-blue-500 focus:border-blue-500 outline-none transition">
              </div>
              <div>
                <label class="block text-sm font-medium mb-1">Temperature</label>
                <input v-model.number="form.temperature" type="number" step="0.1" min="0" max="2" placeholder="Model default"
                  class="w-full px-3 py-2 rounded-lg border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-800 text-sm focus:ring-2 focus:ring-blue-500 focus:border-blue-500 outline-none transition">
              </div>
            </div>
            <div class="grid grid-cols-1 md:grid-cols-2 gap-4 mb-4">
              <div>
                <label class="block text-sm font-medium mb-1">Max Tool Rounds</label>
                <input v-model.number="form.maxToolRounds" type="number"
                  class="w-full px-3 py-2 rounded-lg border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-800 text-sm focus:ring-2 focus:ring-blue-500 focus:border-blue-500 outline-none transition">
              </div>
              <div>
                <label class="block text-sm font-medium mb-1">Timeout (ms)</label>
                <input v-model.number="form.timeoutMs" type="number"
                  class="w-full px-3 py-2 rounded-lg border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-800 text-sm focus:ring-2 focus:ring-blue-500 focus:border-blue-500 outline-none transition">
              </div>
            </div>
            <div class="mb-4">
              <label class="flex items-center gap-2 text-sm font-medium cursor-pointer">
                <input v-model="form.showThinking" type="checkbox"
                  class="w-4 h-4 rounded border-gray-300 dark:border-gray-600 text-blue-600 focus:ring-blue-500">
                Show thinking (send model reasoning to channel as blockquote)
              </label>
            </div>
            <div class="grid grid-cols-1 md:grid-cols-2 gap-4 mb-4">
              <div>
                <label class="block text-sm font-medium mb-1">Mode</label>
                <select v-model="form.mode"
                  class="w-full px-3 py-2 rounded-lg border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-800 text-sm focus:ring-2 focus:ring-blue-500 focus:border-blue-500 outline-none transition">
                  <option value="active">Active</option>
                  <option value="passive">Passive (observe only)</option>
                  <option value="control">Control</option>
                </select>
              </div>
              <div>
                <label class="block text-sm font-medium mb-1">Threading Mode</label>
                <select v-model="form.threadingMode"
                  class="w-full px-3 py-2 rounded-lg border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-800 text-sm focus:ring-2 focus:ring-blue-500 focus:border-blue-500 outline-none transition">
                  <option value="temporal">Temporal (cluster by time/topic)</option>
                  <option value="thread_aware">Thread-aware (cluster by thread)</option>
                </select>
              </div>
            </div>
            <button @click="saveSettings" :disabled="saving"
              class="px-4 py-2 bg-blue-600 hover:bg-blue-700 disabled:opacity-50 text-white rounded-lg text-sm font-medium transition-colors">
              {{ saving ? 'Saving...' : 'Save Settings' }}
            </button>
          </div>
        </div>

        <!-- Prompts Tab -->
        <div v-if="activeTab === 'prompts'">
          <div class="mb-6">
            <label class="block text-sm font-medium mb-2">CLAUDE.md</label>
            <textarea v-model="claude"
              class="w-full h-72 px-4 py-3 rounded-lg border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-800 font-mono text-sm leading-relaxed resize-y focus:ring-2 focus:ring-blue-500 focus:border-blue-500 outline-none transition"></textarea>
          </div>
          <div class="mb-6">
            <label class="block text-sm font-medium mb-2">OLLAMA.md</label>
            <textarea v-model="ollama"
              class="w-full h-48 px-4 py-3 rounded-lg border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-800 font-mono text-sm leading-relaxed resize-y focus:ring-2 focus:ring-blue-500 focus:border-blue-500 outline-none transition"></textarea>
          </div>
          <button @click="savePrompts" :disabled="saving"
            class="px-4 py-2 bg-blue-600 hover:bg-blue-700 disabled:opacity-50 text-white rounded-lg text-sm font-medium transition-colors">
            {{ saving ? 'Saving...' : 'Save Prompts' }}
          </button>
        </div>

        <!-- Tasks Tab -->
        <div v-if="activeTab === 'tasks'">
          <!-- Token Usage Chart -->
          <div v-if="tokenUsage.length" class="bg-white dark:bg-gray-800 rounded-xl border border-gray-200 dark:border-gray-700 p-4 mb-4">
            <h3 class="text-xs font-semibold uppercase tracking-wider text-gray-500 dark:text-gray-400 mb-3">Daily Token Usage</h3>
            <div class="overflow-x-auto">
              <svg :width="chartWidth" height="160" class="block">
                <!-- Y axis labels (tokens, left) -->
                <text v-for="(label, i) in chartYLabels" :key="'y'+i"
                  :x="48" :y="20 + i * (120 / (chartYLabels.length - 1))"
                  text-anchor="end" class="fill-gray-400" style="font-size:10px">{{ label }}</text>
                <!-- Grid lines -->
                <line v-for="(label, i) in chartYLabels" :key="'g'+i"
                  :x1="54" :x2="chartWidth - (hasCostData ? 48 : 4)"
                  :y1="20 + i * (120 / (chartYLabels.length - 1))"
                  :y2="20 + i * (120 / (chartYLabels.length - 1))"
                  stroke="currentColor" class="text-gray-200 dark:text-gray-700" stroke-width="0.5" />
                <!-- Bars -->
                <g v-for="(d, i) in tokenUsage" :key="d.date">
                  <!-- Cached (bottom) -->
                  <rect v-if="d.cached > 0"
                    :x="58 + i * 28" :y="140 - chartBarHeight(d.uncached + d.cached)"
                    :width="20" :height="chartBarHeight(d.uncached + d.cached)"
                    class="fill-blue-300 dark:fill-blue-400/60" rx="2">
                    <title v-text="barTooltip(d)"></title>
                  </rect>
                  <!-- Uncached (top) -->
                  <rect :x="58 + i * 28" :y="140 - chartBarHeight(d.uncached + d.cached)"
                    :width="20" :height="chartBarHeight(d.uncached)"
                    class="fill-blue-500" rx="2">
                    <title v-text="barTooltip(d)"></title>
                  </rect>
                  <!-- Date label -->
                  <text :x="68 + i * 28" y="154" text-anchor="middle" class="fill-gray-400" style="font-size:9px"
                    v-if="tokenUsage.length <= 15 || i % Math.ceil(tokenUsage.length / 15) === 0">{{ d.date.slice(5) }}</text>
                </g>
                <!-- Cost line overlay -->
                <template v-if="hasCostData">
                  <polyline v-for="(seg, si) in costLineSegments" :key="'cl'+si" :points="seg" fill="none" stroke="#f59e0b" stroke-width="1.5" stroke-linejoin="round" />
                  <template v-for="(d, i) in tokenUsage" :key="'c'+i">
                    <circle v-if="d.cost != null"
                      :cx="68 + i * 28" :cy="costY(d.cost)"
                      r="2.5" fill="#f59e0b">
                      <title v-text="d.date + '\\nCost: $' + formatCost(d.cost)"></title>
                    </circle>
                  </template>
                  <!-- Y axis labels (cost, right) -->
                  <text v-for="(label, i) in costYLabels" :key="'cr'+i"
                    :x="chartWidth - 4" :y="20 + i * (120 / (costYLabels.length - 1))"
                    text-anchor="end" class="fill-amber-500" style="font-size:10px">{{ label }}</text>
                </template>
              </svg>
            </div>
            <div class="flex items-center gap-4 mt-2 text-xs text-gray-400">
              <span class="flex items-center gap-1"><span class="inline-block w-3 h-3 rounded-sm bg-blue-300 dark:bg-blue-400/60"></span> Cached</span>
              <span class="flex items-center gap-1"><span class="inline-block w-3 h-3 rounded-sm bg-blue-500"></span> Uncached</span>
              <span v-if="hasCostData" class="flex items-center gap-1"><span class="inline-block w-3 h-0.5 bg-amber-500"></span> Cost (USD)</span>
            </div>
          </div>

          <!-- New Task Button -->
          <div class="flex justify-end mb-4" v-if="!showNewTask">
            <button @click="showNewTask = true"
              class="px-4 py-2 bg-blue-600 hover:bg-blue-700 text-white rounded-lg text-sm font-medium transition-colors">
              New Task
            </button>
          </div>

          <!-- New Task Form -->
          <div v-if="showNewTask" class="bg-white dark:bg-gray-800 rounded-xl border border-gray-200 dark:border-gray-700 p-6 mb-6">
            <h3 class="text-lg font-semibold mb-4">New Task</h3>
            <div class="mb-4">
              <label class="block text-sm font-medium mb-1">Prompt</label>
              <textarea v-model="newTask.prompt" rows="3" placeholder="What should the agent do?"
                class="w-full px-3 py-2 rounded-lg border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-800 font-mono text-sm resize-y focus:ring-2 focus:ring-blue-500 focus:border-blue-500 outline-none transition"></textarea>
            </div>
            <div class="grid grid-cols-1 md:grid-cols-2 gap-4 mb-4">
              <div>
                <label class="block text-sm font-medium mb-1">Schedule Type</label>
                <select v-model="newTask.scheduleType"
                  class="w-full px-3 py-2 rounded-lg border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-800 text-sm focus:ring-2 focus:ring-blue-500 focus:border-blue-500 outline-none transition">
                  <option value="cron">cron</option>
                  <option value="interval">interval</option>
                  <option value="once">once</option>
                </select>
              </div>
              <div>
                <label class="block text-sm font-medium mb-1">Schedule Value</label>
                <input v-model="newTask.scheduleValue" type="text"
                  :class="['w-full px-3 py-2 rounded-lg border font-mono text-sm focus:ring-2 focus:border-blue-500 outline-none transition',
                    newTaskScheduleError ? 'border-red-400 dark:border-red-500 focus:ring-red-500' : 'border-gray-300 dark:border-gray-600 focus:ring-blue-500',
                    'bg-white dark:bg-gray-800']"
                  :placeholder="newTask.scheduleType === 'cron' ? '0 9 * * 1-5' : newTask.scheduleType === 'interval' ? '300000' : 'June 1 2026 9:00 AM'">
                <p v-if="newTaskScheduleError" class="mt-1 text-xs text-red-500">{{ newTaskScheduleError }}</p>
                <p v-else-if="newTaskScheduleHint" class="mt-1 text-xs text-gray-400">{{ newTaskScheduleHint }}</p>
              </div>
            </div>
            <div class="grid grid-cols-1 md:grid-cols-2 gap-4 mb-4">
              <div>
                <label class="block text-sm font-medium mb-1">Model</label>
                <input v-model="newTask.model" type="text" placeholder="Inherit from group"
                  class="w-full px-3 py-2 rounded-lg border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-800 text-sm focus:ring-2 focus:ring-blue-500 focus:border-blue-500 outline-none transition">
              </div>
              <div>
                <label class="block text-sm font-medium mb-1">Temperature</label>
                <input v-model.number="newTask.temperature" type="number" step="0.1" min="0" max="2" placeholder="Model default"
                  class="w-full px-3 py-2 rounded-lg border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-800 text-sm focus:ring-2 focus:ring-blue-500 focus:border-blue-500 outline-none transition">
              </div>
            </div>
            <div class="grid grid-cols-1 md:grid-cols-2 gap-4 mb-4">
              <div>
                <label class="block text-sm font-medium mb-1">Timezone</label>
                <input v-model="newTask.timezone" type="text" placeholder="UTC"
                  class="w-full px-3 py-2 rounded-lg border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-800 text-sm focus:ring-2 focus:ring-blue-500 focus:border-blue-500 outline-none transition">
              </div>
              <div>
                <label class="block text-sm font-medium mb-1">Context Mode</label>
                <select v-model="newTask.contextMode"
                  class="w-full px-3 py-2 rounded-lg border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-800 text-sm focus:ring-2 focus:ring-blue-500 focus:border-blue-500 outline-none transition">
                  <option value="isolated">Isolated</option>
                  <option value="group">Group</option>
                </select>
              </div>
            </div>
            <div class="grid grid-cols-1 md:grid-cols-2 gap-4 mb-4">
              <div>
                <label class="block text-sm font-medium mb-1">Max Tool Rounds</label>
                <input v-model.number="newTask.maxToolRounds" type="number" placeholder="Default"
                  class="w-full px-3 py-2 rounded-lg border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-800 text-sm focus:ring-2 focus:ring-blue-500 focus:border-blue-500 outline-none transition">
              </div>
              <div>
                <label class="block text-sm font-medium mb-1">Timeout (ms)</label>
                <input v-model.number="newTask.timeoutMs" type="number" placeholder="Default"
                  class="w-full px-3 py-2 rounded-lg border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-800 text-sm focus:ring-2 focus:ring-blue-500 focus:border-blue-500 outline-none transition">
              </div>
            </div>
            <div class="mb-4">
              <label class="flex items-center gap-2 cursor-pointer">
                <input type="checkbox" v-model="newTask.useAgentSdk" class="w-4 h-4 rounded border-gray-300 text-blue-600 focus:ring-blue-500">
                <span class="text-sm font-medium">Use full Agent SDK</span>
                <span class="text-xs text-gray-500 dark:text-gray-400">Enable for tasks needing file access, bash, or web search</span>
              </label>
            </div>
            <div class="flex gap-3">
              <button @click="createNewTask" :disabled="saving || !newTask.prompt.trim() || !newTask.scheduleValue.trim() || !!newTaskScheduleError"
                class="px-4 py-2 bg-blue-600 hover:bg-blue-700 disabled:opacity-50 text-white rounded-lg text-sm font-medium transition-colors">
                {{ saving ? 'Creating...' : 'Create Task' }}
              </button>
              <button @click="showNewTask = false"
                class="px-4 py-2 bg-gray-200 hover:bg-gray-300 dark:bg-gray-700 dark:hover:bg-gray-600 rounded-lg text-sm font-medium transition-colors">
                Cancel
              </button>
            </div>
          </div>

          <div class="bg-white dark:bg-gray-800 rounded-xl border border-gray-200 dark:border-gray-700 overflow-hidden">
            <table v-if="tasks.length" class="w-full text-sm">
              <thead>
                <tr class="border-b border-gray-200 dark:border-gray-700">
                  <th class="text-left px-4 py-3 text-xs font-semibold uppercase tracking-wider text-gray-500 dark:text-gray-400">Prompt</th>
                  <th class="text-left px-4 py-3 text-xs font-semibold uppercase tracking-wider text-gray-500 dark:text-gray-400">Schedule</th>
                  <th class="text-left px-4 py-3 text-xs font-semibold uppercase tracking-wider text-gray-500 dark:text-gray-400">Status</th>
                  <th class="text-left px-4 py-3 text-xs font-semibold uppercase tracking-wider text-gray-500 dark:text-gray-400">Next Run</th>
                </tr>
              </thead>
              <tbody>
                <tr v-for="t in tasks" :key="t.id" @click="navigate('/tasks/' + t.id)"
                  class="border-b border-gray-100 dark:border-gray-700/50 last:border-0 cursor-pointer hover:bg-gray-50 dark:hover:bg-gray-700/50 transition-colors">
                  <td class="px-4 py-3">{{ t.prompt.length > 60 ? t.prompt.slice(0, 60) + '...' : t.prompt }}</td>
                  <td class="px-4 py-3 font-mono text-xs text-gray-500">{{ t.scheduleValue }}</td>
                  <td class="px-4 py-3"><status-badge :status="t.status" /></td>
                  <td class="px-4 py-3 text-gray-500 text-xs">{{ t.nextRun ? new Date(t.nextRun).toLocaleString() : '—' }}</td>
                </tr>
              </tbody>
            </table>
            <p v-else class="px-4 py-8 text-center text-gray-400 text-sm">No scheduled tasks</p>
          </div>
        </div>
      </div>
    </div>
  `,
  setup(props) {
    const group = ref(null);
    const tasks = ref([]);
    const claude = ref('');
    const ollama = ref('');
    const loading = ref(true);
    const saving = ref(false);
    const activeTab = ref(props.initialTab || 'tasks');
    const tokenUsage = ref([]);
    let taskInterval = null;

    const form = Vue.reactive({ model: '', temperature: null, maxToolRounds: null, timeoutMs: null, showThinking: false, mode: 'active', threadingMode: 'temporal' });
    const showNewTask = ref(false);
    const newTask = Vue.reactive({
      prompt: '', scheduleType: 'cron', scheduleValue: '', contextMode: 'isolated',
      model: '', temperature: null, timezone: '', maxToolRounds: null, timeoutMs: null, useAgentSdk: false,
    });

    const newTaskScheduleError = computed(() => validateSchedule(newTask.scheduleType, newTask.scheduleValue));
    const newTaskScheduleHint = computed(() => scheduleHintText(newTask.scheduleType, newTask.scheduleValue));

    const tabs = computed(() => [
      { key: 'tasks', label: 'Tasks', count: tasks.value.length },
      { key: 'prompts', label: 'Prompts' },
      { key: 'settings', label: 'Settings' },
    ]);

    const fetchTasks = async () => {
      try { tasks.value = await api(`/groups/${props.folder}/tasks`); } catch {}
    };
    const fetchTokenUsage = async () => {
      try { tokenUsage.value = await api(`/groups/${props.folder}/token-usage`); } catch {}
    };

    onMounted(async () => {
      try {
        const [g, p, t, tu] = await Promise.all([
          api(`/groups/${props.folder}`),
          api(`/groups/${props.folder}/prompts`),
          api(`/groups/${props.folder}/tasks`),
          api(`/groups/${props.folder}/token-usage`).catch(() => []),
        ]);
        group.value = g;
        form.model = g.model || '';
        form.temperature = g.temperature;
        form.maxToolRounds = g.maxToolRounds;
        form.timeoutMs = g.timeoutMs;
        form.showThinking = g.showThinking ?? false;
        form.mode = g.mode || 'active';
        form.threadingMode = g.threadingMode || 'temporal';
        claude.value = p.claude;
        ollama.value = p.ollama || '';
        tasks.value = t;
        tokenUsage.value = tu;
      } catch (e) { showToast(e.message, 'error'); }
      loading.value = false;
      taskInterval = setInterval(() => { fetchTasks(); fetchTokenUsage(); }, 10000);
    });

    onUnmounted(() => { if (taskInterval) clearInterval(taskInterval); });

    const saveSettings = async () => {
      saving.value = true;
      try {
        const body = {};
        if (form.model != null) body.model = form.model;
        if (form.temperature != null) body.temperature = form.temperature;
        if (form.maxToolRounds != null) body.maxToolRounds = form.maxToolRounds;
        if (form.timeoutMs != null) body.timeoutMs = form.timeoutMs;
        body.showThinking = form.showThinking;
        body.mode = form.mode;
        body.threadingMode = form.threadingMode;
        await api(`/groups/${props.folder}`, { method: 'PATCH', body });
        showToast('Settings saved');
      } catch (e) { showToast(e.message, 'error'); }
      saving.value = false;
    };

    const savePrompts = async () => {
      saving.value = true;
      try {
        await api(`/groups/${props.folder}/prompts`, {
          method: 'PUT',
          body: { claude: claude.value, ollama: ollama.value || undefined },
        });
        showToast('Prompts saved');
      } catch (e) { showToast(e.message, 'error'); }
      saving.value = false;
    };

    const selectTab = (tab) => {
      activeTab.value = tab;
      const hashBase = `#/groups/${props.folder}`;
      window.location.hash = tab === 'tasks' ? hashBase : `${hashBase}?tab=${tab}`;
    };

    const createNewTask = async () => {
      saving.value = true;
      try {
        const body = {
          prompt: newTask.prompt,
          scheduleType: newTask.scheduleType,
          scheduleValue: normalizeScheduleValue(newTask.scheduleType, newTask.scheduleValue),
          contextMode: newTask.contextMode,
        };
        if (newTask.model) body.model = newTask.model;
        if (newTask.temperature != null) body.temperature = newTask.temperature;
        if (newTask.timezone) body.timezone = newTask.timezone;
        if (newTask.maxToolRounds != null) body.maxToolRounds = newTask.maxToolRounds;
        if (newTask.timeoutMs != null) body.timeoutMs = newTask.timeoutMs;
        if (newTask.useAgentSdk) body.useAgentSdk = true;
        const created = await api(`/groups/${props.folder}/tasks`, { method: 'POST', body });
        tasks.value.push(created);
        showNewTask.value = false;
        // Reset form
        newTask.prompt = '';
        newTask.scheduleType = 'cron';
        newTask.scheduleValue = '';
        newTask.contextMode = 'isolated';
        newTask.model = '';
        newTask.temperature = null;
        newTask.timezone = '';
        newTask.maxToolRounds = null;
        newTask.timeoutMs = null;
        newTask.useAgentSdk = false;
        showToast('Task created');
      } catch (e) { showToast(e.message, 'error'); }
      saving.value = false;
    };

    const navigate = (path) => { window.location.hash = path; };

    const chartMax = computed(() => {
      let max = 0;
      for (const d of tokenUsage.value) {
        const total = d.uncached + d.cached;
        if (total > max) max = total;
      }
      return max || 1;
    });

    const chartBarHeight = (tokens) => {
      if (chartMax.value === 0) return 0;
      return Math.max((tokens / chartMax.value) * 120, tokens > 0 ? 1 : 0);
    };

    const chartYLabels = computed(() => {
      const max = chartMax.value;
      if (max === 0) return ['0'];
      const fmt = (n) => n >= 1000000 ? (n / 1000000).toFixed(1).replace(/\.0$/, '') + 'M' : n >= 1000 ? (n / 1000).toFixed(0) + 'k' : String(n);
      return [fmt(max), fmt(Math.round(max * 0.5)), '0'];
    });

    const formatTokens = (n) => {
      if (n >= 1000000) return (n / 1000000).toFixed(1).replace(/\.0$/, '') + 'M';
      if (n >= 1000) return (n / 1000).toFixed(1).replace(/\.0$/, '') + 'k';
      return String(n);
    };

    const formatCost = (n) => n != null ? n.toFixed(4) : '0';

    const barTooltip = (d) => {
      let s = d.date + '\nUncached: ' + formatTokens(d.uncached) + '\nCached: ' + formatTokens(d.cached) + '\nTotal: ' + formatTokens(d.uncached + d.cached);
      if (d.cost != null) s += '\nCost: $' + formatCost(d.cost);
      return s;
    };

    const hasCostData = computed(() => tokenUsage.value.some(d => d.cost != null && d.cost > 0));

    const costMax = computed(() => {
      let max = 0;
      for (const d of tokenUsage.value) {
        if (d.cost != null && d.cost > max) max = d.cost;
      }
      return max || 1;
    });

    const costY = (cost) => {
      if (cost == null || costMax.value === 0) return 140;
      return 140 - (cost / costMax.value) * 120;
    };

    const costLineSegments = computed(() => {
      const segments = [];
      let current = [];
      for (let i = 0; i < tokenUsage.value.length; i++) {
        const d = tokenUsage.value[i];
        if (d.cost != null) {
          current.push(`${68 + i * 28},${costY(d.cost)}`);
        } else if (current.length > 0) {
          segments.push(current.join(' '));
          current = [];
        }
      }
      if (current.length > 0) segments.push(current.join(' '));
      return segments;
    });

    const costYLabels = computed(() => {
      const max = costMax.value;
      if (max === 0) return ['$0'];
      const fmt = (n) => '$' + (n >= 1 ? n.toFixed(2) : n.toFixed(4)).replace(/0+$/, '').replace(/\.$/, '');
      return [fmt(max), fmt(max * 0.5), '$0'];
    });

    const chartWidth = computed(() => {
      const base = Math.max(tokenUsage.value.length * 28 + 60, 200);
      return hasCostData.value ? base + 48 : base;
    });

    return { group, tasks, claude, ollama, loading, saving, activeTab, form, tabs, showNewTask, newTask, newTaskScheduleError, newTaskScheduleHint, selectTab, createNewTask, saveSettings, savePrompts, navigate, tokenUsage, chartMax, chartBarHeight, chartYLabels, formatTokens, formatCost, barTooltip, hasCostData, costMax, costY, costLineSegments, costYLabels, chartWidth };
  },
};

// Task Detail (Tabbed)
const AppTaskDetail = {
  props: ['taskId'],
  emits: ['group-loaded'],
  template: `
    <div>
      <!-- Back link -->
      <a v-if="task" :href="taskId.startsWith('pipeline:') ? '#/pipeline' : '#/groups/' + task.groupFolder" class="inline-flex items-center gap-1 text-sm text-gray-400 hover:text-gray-600 dark:hover:text-gray-300 mb-4 transition-colors">
        <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">${icons.back}</svg>
        {{ taskId.startsWith('pipeline:') ? 'Back to Pipeline' : 'Back to ' + (group?.name || task.groupFolder) }}
      </a>

      <h2 class="text-2xl font-bold mb-1">Task</h2>
      <p class="text-sm text-gray-400 mb-6 font-mono">{{ taskId }}</p>

      <div v-if="loading" class="text-gray-400 text-sm">Loading...</div>
      <div v-else-if="task">
        <tab-bar :tabs="tabs" :active="activeTab" @select="activeTab = $event" />

        <!-- Prompt Tab -->
        <div v-if="activeTab === 'prompt'">
          <div class="mb-6">
            <label class="block text-sm font-medium mb-2">Prompt</label>
            <textarea v-model="promptText"
              class="w-full h-48 px-4 py-3 rounded-lg border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-800 font-mono text-sm leading-relaxed resize-y focus:ring-2 focus:ring-blue-500 focus:border-blue-500 outline-none transition"></textarea>
          </div>
          <button @click="save" :disabled="saving"
            class="px-4 py-2 bg-blue-600 hover:bg-blue-700 disabled:opacity-50 text-white rounded-lg text-sm font-medium transition-colors">
            {{ saving ? 'Saving...' : 'Save' }}
          </button>
        </div>

        <!-- Settings Tab -->
        <div v-if="activeTab === 'settings'">
          <div class="bg-white dark:bg-gray-800 rounded-xl border border-gray-200 dark:border-gray-700 p-6">
            <div v-if="task?.scheduleType === 'event' || task?.subscribedEventTypes?.length" class="mb-4">
              <div class="px-3 py-2 rounded-lg border border-gray-200 dark:border-gray-700 bg-gray-50 dark:bg-gray-900 mb-2">
                <div class="text-sm font-medium mb-1">Trigger</div>
                <div class="text-purple-600 dark:text-purple-400 text-sm">Event-driven</div>
                <div v-if="task?.subscribedEventTypes?.length" class="text-xs text-gray-400 font-mono mt-1">{{ task.subscribedEventTypes.join(', ') }}</div>
              </div>
              <div class="grid grid-cols-1 md:grid-cols-2 gap-4">
                <div>
                  <label class="block text-sm font-medium mb-1">Fallback Poll (ms)</label>
                  <input v-model.number="form.fallbackPollMs" type="number" placeholder="Optional — e.g. 3600000 for hourly"
                    class="w-full px-3 py-2 rounded-lg border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-800 text-sm focus:ring-2 focus:ring-blue-500 focus:border-blue-500 outline-none transition">
                  <p class="mt-1 text-xs text-gray-400">Safety net poll interval. Leave empty for purely event-driven.</p>
                </div>
              </div>
            </div>
            <div v-else class="grid grid-cols-1 md:grid-cols-2 gap-4 mb-4">
              <div>
                <label class="block text-sm font-medium mb-1">Schedule Type</label>
                <select v-model="form.scheduleType"
                  class="w-full px-3 py-2 rounded-lg border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-800 text-sm focus:ring-2 focus:ring-blue-500 focus:border-blue-500 outline-none transition">
                  <option value="cron">cron</option>
                  <option value="interval">interval</option>
                  <option value="once">once</option>
                </select>
              </div>
              <div>
                <label class="block text-sm font-medium mb-1">Schedule Value</label>
                <input v-model="form.scheduleValue" type="text"
                  :class="['w-full px-3 py-2 rounded-lg border font-mono text-sm focus:ring-2 focus:border-blue-500 outline-none transition',
                    scheduleError ? 'border-red-400 dark:border-red-500 focus:ring-red-500' : 'border-gray-300 dark:border-gray-600 focus:ring-blue-500',
                    'bg-white dark:bg-gray-800']"
                  :placeholder="form.scheduleType === 'cron' ? '*/15 * * * *' : form.scheduleType === 'interval' ? '300000' : 'June 1 2026 9:00 AM'">
                <p v-if="scheduleError" class="mt-1 text-xs text-red-500">{{ scheduleError }}</p>
                <p v-else-if="scheduleHint" class="mt-1 text-xs text-gray-400">{{ scheduleHint }}</p>
              </div>
            </div>
            <div class="grid grid-cols-1 md:grid-cols-2 gap-4 mb-4">
              <div>
                <label class="block text-sm font-medium mb-1">Model</label>
                <input v-model="form.model" type="text"
                  :placeholder="modelPlaceholder"
                  class="w-full px-3 py-2 rounded-lg border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-800 text-sm focus:ring-2 focus:ring-blue-500 focus:border-blue-500 outline-none transition">
              </div>
              <div>
                <label class="block text-sm font-medium mb-1">Temperature</label>
                <input v-model.number="form.temperature" type="number" step="0.1" min="0" max="2"
                  :placeholder="temperaturePlaceholder"
                  class="w-full px-3 py-2 rounded-lg border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-800 text-sm focus:ring-2 focus:ring-blue-500 focus:border-blue-500 outline-none transition">
              </div>
            </div>
            <div class="grid grid-cols-1 md:grid-cols-2 gap-4 mb-4">
              <div>
                <label class="block text-sm font-medium mb-1">Timezone</label>
                <input v-model="form.timezone" type="text"
                  class="w-full px-3 py-2 rounded-lg border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-800 text-sm focus:ring-2 focus:ring-blue-500 focus:border-blue-500 outline-none transition">
              </div>
              <div>
                <label class="block text-sm font-medium mb-1">Context Mode</label>
                <select v-model="form.contextMode"
                  class="w-full px-3 py-2 rounded-lg border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-800 text-sm focus:ring-2 focus:ring-blue-500 focus:border-blue-500 outline-none transition">
                  <option value="isolated">Isolated</option>
                  <option value="group">Group</option>
                </select>
              </div>
            </div>
            <div class="grid grid-cols-1 md:grid-cols-2 gap-4 mb-4">
              <div>
                <label class="block text-sm font-medium mb-1">Max Tool Rounds</label>
                <input v-model.number="form.maxToolRounds" type="number"
                  class="w-full px-3 py-2 rounded-lg border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-800 text-sm focus:ring-2 focus:ring-blue-500 focus:border-blue-500 outline-none transition">
              </div>
              <div>
                <label class="block text-sm font-medium mb-1">Timeout (ms)</label>
                <input v-model.number="form.timeoutMs" type="number"
                  class="w-full px-3 py-2 rounded-lg border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-800 text-sm focus:ring-2 focus:ring-blue-500 focus:border-blue-500 outline-none transition">
              </div>
            </div>
            <div class="grid grid-cols-1 md:grid-cols-2 gap-4 mb-4">
              <div>
                <label class="block text-sm font-medium mb-1">Status</label>
                <select v-model="form.status"
                  class="w-full px-3 py-2 rounded-lg border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-800 text-sm focus:ring-2 focus:ring-blue-500 focus:border-blue-500 outline-none transition">
                  <option value="active">Active</option>
                  <option value="paused">Paused</option>
                </select>
              </div>
              <div class="flex items-end">
                <label class="flex items-center gap-2 cursor-pointer">
                  <input type="checkbox" v-model="form.useAgentSdk" class="w-4 h-4 rounded border-gray-300 text-blue-600 focus:ring-blue-500">
                  <span class="text-sm font-medium">Use full Agent SDK</span>
                </label>
                <span class="ml-2 text-xs text-gray-500 dark:text-gray-400">Enable for tasks needing file access, bash, or web search</span>
              </div>
            </div>
            <div class="grid grid-cols-1 md:grid-cols-2 gap-4 mb-4">
              <div>
                <label class="block text-sm font-medium mb-1">Execution Mode</label>
                <select v-model="form.executionMode"
                  class="w-full px-3 py-2 rounded-lg border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-800 text-sm focus:ring-2 focus:ring-blue-500 focus:border-blue-500 outline-none transition">
                  <option value="container">Container</option>
                  <option value="host_pipeline">Host Pipeline</option>
                </select>
              </div>
              <div>
                <label class="block text-sm font-medium mb-1">Subscribed Event Types</label>
                <input v-model="form.subscribedEventTypes" type="text" placeholder='e.g. intake.raw, observation.*'
                  class="w-full px-3 py-2 rounded-lg border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-800 text-sm focus:ring-2 focus:ring-blue-500 focus:border-blue-500 outline-none transition">
              </div>
            </div>
            <div class="grid grid-cols-1 md:grid-cols-2 gap-4 mb-4">
              <div v-if="taskId.startsWith('pipeline:')">
                <label class="block text-sm font-medium mb-1">Allowed Profiles</label>
                <div class="px-3 py-2 rounded-lg border border-gray-200 dark:border-gray-700 bg-gray-50 dark:bg-gray-900 text-sm min-h-[4rem]">
                  <div v-if="task?.allowedTools?.length" class="text-xs text-gray-400 mb-1">Resolved from YAML spec profiles. Edit profiles in pipeline/*.yaml.</div>
                  <div v-else class="text-gray-400 text-xs">No tool restrictions</div>
                  <span v-if="task?.allowedTools" v-for="t in task.allowedTools" :key="t"
                    class="inline-block px-1.5 py-0.5 mr-1 mb-0.5 rounded bg-indigo-100 dark:bg-indigo-900 text-indigo-800 dark:text-indigo-200 font-mono text-[11px]">{{ t }}</span>
                </div>
              </div>
              <div v-else>
                <label class="block text-sm font-medium mb-1">Allowed Tools</label>
                <textarea v-model="form.allowedTools" rows="3" placeholder='JSON array, e.g. ["consume_events","publish_event"]'
                  class="w-full px-3 py-2 rounded-lg border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-800 text-sm focus:ring-2 focus:ring-blue-500 focus:border-blue-500 outline-none transition font-mono"></textarea>
              </div>
              <div>
                <label class="block text-sm font-medium mb-1">Allowed Send Targets</label>
                <textarea v-model="form.allowedSendTargets" rows="3" placeholder='JSON array, e.g. ["slack:CPASSIVE"]'
                  :disabled="taskId.startsWith('pipeline:')"
                  :class="taskId.startsWith('pipeline:') ? 'bg-gray-50 dark:bg-gray-900 cursor-not-allowed' : ''"
                  class="w-full px-3 py-2 rounded-lg border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-800 text-sm focus:ring-2 focus:ring-blue-500 focus:border-blue-500 outline-none transition font-mono"></textarea>
              </div>
            </div>
            <button @click="save" :disabled="saving || !!scheduleError"
              class="px-4 py-2 bg-blue-600 hover:bg-blue-700 disabled:opacity-50 text-white rounded-lg text-sm font-medium transition-colors">
              {{ saving ? 'Saving...' : 'Save Settings' }}
            </button>
          </div>
        </div>

        <!-- Run History Tab -->
        <div v-if="activeTab === 'runs'">
          <div class="bg-white dark:bg-gray-800 rounded-xl border border-gray-200 dark:border-gray-700 overflow-hidden">
            <table v-if="runs.length" class="w-full text-sm">
              <thead>
                <tr class="border-b border-gray-200 dark:border-gray-700">
                  <th class="text-left px-4 py-3 text-xs font-semibold uppercase tracking-wider text-gray-500 dark:text-gray-400">Run At</th>
                  <th class="text-left px-4 py-3 text-xs font-semibold uppercase tracking-wider text-gray-500 dark:text-gray-400">Duration</th>
                  <th class="text-left px-4 py-3 text-xs font-semibold uppercase tracking-wider text-gray-500 dark:text-gray-400">Status</th>
                  <th class="text-left px-4 py-3 text-xs font-semibold uppercase tracking-wider text-gray-500 dark:text-gray-400">Result</th>
                </tr>
              </thead>
              <tbody>
                <tr v-for="r in runs" :key="r.runAt" class="border-b border-gray-100 dark:border-gray-700/50 last:border-0">
                  <td class="px-4 py-3 text-xs">{{ new Date(r.runAt).toLocaleString() }}</td>
                  <td class="px-4 py-3 text-gray-500">{{ (r.durationMs / 1000).toFixed(1) }}s</td>
                  <td class="px-4 py-3"><status-badge :status="r.status" /></td>
                  <td class="px-4 py-3 text-gray-500 text-xs truncate max-w-xs">{{ (r.result || r.error || '—').slice(0, 80) }}</td>
                </tr>
              </tbody>
            </table>
            <p v-else class="px-4 py-8 text-center text-gray-400 text-sm">No runs yet</p>
          </div>
        </div>

        <!-- Delete Section -->
        <div class="mt-8 pt-6 border-t border-gray-200 dark:border-gray-700">
          <button @click="showDeleteDialog = true"
            class="px-4 py-2 bg-red-600 hover:bg-red-700 text-white rounded-lg text-sm font-medium transition-colors">
            Delete Task
          </button>
        </div>

        <!-- Delete Confirmation Dialog -->
        <div v-if="showDeleteDialog" class="fixed inset-0 z-50 flex items-center justify-center">
          <div @click="cancelDelete" class="absolute inset-0 bg-black/50"></div>
          <div class="relative bg-white dark:bg-gray-800 rounded-xl border border-gray-200 dark:border-gray-700 p-6 shadow-xl max-w-md w-full mx-4">
            <h3 class="text-lg font-semibold mb-2">Delete Task</h3>
            <p class="text-sm text-gray-500 dark:text-gray-400 mb-4">
              Are you sure you want to delete task <span class="font-mono font-medium text-gray-700 dark:text-gray-300">{{ taskId }}</span>? This action cannot be undone.
            </p>
            <div class="mb-4">
              <label class="block text-sm font-medium mb-1">Type the task ID to confirm</label>
              <input v-model="deleteConfirmId" type="text" placeholder="Paste task ID here"
                class="w-full px-3 py-2 rounded-lg border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-800 font-mono text-sm focus:ring-2 focus:ring-red-500 focus:border-red-500 outline-none transition">
            </div>
            <div class="flex gap-3 justify-end">
              <button @click="cancelDelete"
                class="px-4 py-2 bg-gray-200 hover:bg-gray-300 dark:bg-gray-700 dark:hover:bg-gray-600 rounded-lg text-sm font-medium transition-colors">
                Cancel
              </button>
              <button @click="confirmDelete" :disabled="deleteConfirmId !== taskId || deleting"
                class="px-4 py-2 bg-red-600 hover:bg-red-700 disabled:opacity-50 text-white rounded-lg text-sm font-medium transition-colors">
                {{ deleting ? 'Deleting...' : 'Delete' }}
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>
  `,
  setup(props, { emit }) {
    const task = ref(null);
    const group = ref(null);
    const runs = ref([]);
    const promptText = ref('');
    const loading = ref(true);
    const saving = ref(false);
    const deleting = ref(false);
    const showDeleteDialog = ref(false);
    const deleteConfirmId = ref('');
    const activeTab = ref('prompt');
    let runsInterval = null;

    const form = Vue.reactive({
      scheduleType: '', scheduleValue: '', contextMode: 'isolated', model: '', temperature: null, timezone: '',
      maxToolRounds: null, timeoutMs: null, useAgentSdk: false, status: 'active',
      executionMode: 'container', subscribedEventTypes: '', allowedTools: '', allowedSendTargets: '', fallbackPollMs: null,
    });

    const modelPlaceholder = computed(() => {
      if (group.value?.model) return `Inherited from group: ${group.value.model}`;
      return 'System default';
    });

    const temperaturePlaceholder = computed(() => {
      if (group.value?.temperature != null) return `Inherited from group: ${group.value.temperature}`;
      return 'Model default';
    });

    const tabs = computed(() => [
      { key: 'prompt', label: 'Prompt' },
      { key: 'settings', label: 'Settings' },
      { key: 'runs', label: 'Run History', count: runs.value.length },
    ]);

    const scheduleError = computed(() => validateSchedule(form.scheduleType, form.scheduleValue));
    const scheduleHint = computed(() => scheduleHintText(form.scheduleType, form.scheduleValue));

    const fetchRuns = async () => {
      try { runs.value = await api(`/tasks/${props.taskId}/runs?limit=20`); } catch {}
    };

    onMounted(async () => {
      try {
        const [t, r] = await Promise.all([
          api(`/tasks/${props.taskId}`),
          api(`/tasks/${props.taskId}/runs?limit=20`),
        ]);
        task.value = t;
        emit('group-loaded', t.groupFolder);
        promptText.value = t.prompt;
        form.scheduleType = t.scheduleType;
        form.scheduleValue = t.scheduleValue;
        form.contextMode = t.contextMode || 'isolated';
        form.model = t.model || '';
        form.temperature = t.temperature;
        form.timezone = t.timezone || '';
        form.maxToolRounds = t.maxToolRounds;
        form.timeoutMs = t.timeoutMs;
        form.useAgentSdk = !!t.useAgentSdk;
        form.executionMode = t.executionMode || 'container';
        form.subscribedEventTypes = t.subscribedEventTypes ? t.subscribedEventTypes.join(', ') : '';
        form.fallbackPollMs = t.fallbackPollMs || null;
        form.allowedTools = t.allowedTools ? JSON.stringify(t.allowedTools) : '';
        form.allowedSendTargets = t.allowedSendTargets ? JSON.stringify(t.allowedSendTargets) : '';
        form.status = t.status;
        runs.value = r;
        // Fetch group to show inherited model as placeholder
        try { group.value = await api(`/groups/${t.groupFolder}`); } catch {}
      } catch (e) { showToast(e.message, 'error'); }
      loading.value = false;
      runsInterval = setInterval(fetchRuns, 10000);
    });

    onUnmounted(() => { if (runsInterval) clearInterval(runsInterval); });

    const save = async () => {
      saving.value = true;
      try {
        const body = { prompt: promptText.value };
        if (form.scheduleType) body.scheduleType = form.scheduleType;
        if (form.scheduleValue) body.scheduleValue = normalizeScheduleValue(form.scheduleType, form.scheduleValue);
        body.contextMode = form.contextMode;
        if (form.model != null) body.model = form.model;
        if (form.temperature != null) body.temperature = form.temperature;
        if (form.timezone) body.timezone = form.timezone;
        if (form.maxToolRounds != null) body.maxToolRounds = form.maxToolRounds;
        if (form.timeoutMs != null) body.timeoutMs = form.timeoutMs;
        body.useAgentSdk = form.useAgentSdk;
        body.executionMode = form.executionMode;
        body.subscribedEventTypes = form.subscribedEventTypes ? form.subscribedEventTypes.split(',').map(s => s.trim()).filter(Boolean) : null;
        if (form.fallbackPollMs != null) body.fallbackPollMs = form.fallbackPollMs;
        // Pipeline tasks: tools are spec-derived, don't send from UI
        if (!props.taskId.startsWith('pipeline:')) {
          try { body.allowedTools = form.allowedTools ? JSON.parse(form.allowedTools) : null; } catch { body.allowedTools = undefined; }
        }
        try { body.allowedSendTargets = form.allowedSendTargets ? JSON.parse(form.allowedSendTargets) : null; } catch { body.allowedSendTargets = undefined; }
        body.status = form.status;
        const updated = await api(`/tasks/${props.taskId}`, { method: 'PATCH', body });
        task.value = updated;
        showToast('Task saved');
      } catch (e) { showToast(e.message, 'error'); }
      saving.value = false;
    };

    const cancelDelete = () => {
      showDeleteDialog.value = false;
      deleteConfirmId.value = '';
    };

    const confirmDelete = async () => {
      if (deleteConfirmId.value !== props.taskId) return;
      deleting.value = true;
      try {
        await api(`/tasks/${props.taskId}`, { method: 'DELETE' });
        showToast('Task deleted');
        window.location.hash = `/groups/${task.value.groupFolder}?tab=tasks`;
      } catch (e) { showToast(e.message, 'error'); }
      deleting.value = false;
    };

    return { task, group, runs, promptText, loading, saving, deleting, showDeleteDialog, deleteConfirmId, activeTab, form, tabs, save, cancelDelete, confirmDelete, scheduleError, scheduleHint, modelPlaceholder, temperaturePlaceholder };
  },
};

// ── App ────────────────────────────────────────────────────

// Pipeline page
const AppPipeline = {
  template: `
    <div>
      <h1 class="text-2xl font-bold mb-6">Pipeline</h1>

      <!-- Team Group -->
      <div v-if="data.teamGroup" class="mb-6 flex items-center gap-3">
        <span class="text-sm font-semibold text-gray-500 uppercase">Team Channel:</span>
        <a :href="'#/groups/' + data.teamGroup.folder"
          class="px-3 py-1.5 bg-green-100 dark:bg-green-900 text-green-800 dark:text-green-200 rounded-full text-sm font-medium hover:opacity-80 transition-opacity">
          {{ data.teamGroup.name }}
        </a>
        <span class="text-xs text-gray-400 font-mono">{{ data.teamGroup.jid }}</span>
      </div>

      <!-- Source Channels -->
      <div class="mb-6">
        <h2 class="text-sm font-semibold text-gray-500 uppercase mb-3">Source Channels (passive)</h2>
        <div v-if="data.sourceChannels?.length" class="flex flex-wrap gap-2">
          <span v-for="ch in data.sourceChannels" :key="ch.jid"
            class="px-3 py-1.5 bg-blue-100 dark:bg-blue-900 text-blue-800 dark:text-blue-200 rounded-full text-sm font-medium">
            {{ ch.name }}
            <span class="text-xs opacity-60 ml-1">({{ ch.threading_mode }})</span>
          </span>
        </div>
        <div v-else class="text-sm text-gray-400">No passive channels configured</div>
      </div>

      <!-- Tasks -->
      <div class="mb-6">
        <h2 class="text-sm font-semibold text-gray-500 uppercase mb-3">Pipeline Tasks</h2>
        <div class="bg-white dark:bg-gray-800 rounded-xl border border-gray-200 dark:border-gray-700 overflow-hidden">
          <table v-if="data.tasks?.length" class="w-full text-sm">
            <thead>
              <tr class="border-b border-gray-200 dark:border-gray-700">
                <th class="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase">Task</th>
                <th class="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase">Model</th>
                <th class="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase">Allowed Profiles</th>
                <th class="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase">Trigger</th>
                <th class="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase">Status</th>
                <th class="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase">Last Run</th>
                <th class="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase">Last Result</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="t in data.tasks" :key="t.id"
                @click="window.location.hash = '#/tasks/' + t.id"
                class="border-b border-gray-100 dark:border-gray-700/50 hover:bg-gray-50 dark:hover:bg-gray-750 cursor-pointer">
                <td class="px-4 py-3 font-medium">{{ t.id.replace('pipeline:', '') }}</td>
                <td class="px-4 py-3 font-mono text-xs">{{ t.model || '-' }}</td>
                <td class="px-4 py-3 text-xs">
                  <span v-for="p in t.profiles" :key="p"
                    class="inline-block px-1.5 py-0.5 mr-1 mb-0.5 rounded bg-indigo-100 dark:bg-indigo-900 text-indigo-800 dark:text-indigo-200 font-mono text-[11px]">{{ p }}</span>
                  <span v-for="e in t.extra_tools" :key="e"
                    class="inline-block px-1.5 py-0.5 mr-1 mb-0.5 rounded bg-gray-100 dark:bg-gray-700 text-gray-600 dark:text-gray-300 font-mono text-[11px]">{{ e }}</span>
                  <span v-if="!t.profiles?.length && !t.extra_tools?.length" class="text-gray-400">-</span>
                </td>
                <td class="px-4 py-3 text-xs">
                  <template v-if="t.subscribed_event_types">
                    <span class="text-purple-600 dark:text-purple-400">event-driven</span>
                    <div class="text-[10px] text-gray-400 font-mono mt-0.5">{{ JSON.parse(t.subscribed_event_types).join(', ') }}</div>
                  </template>
                  <span v-else class="font-mono">{{ t.schedule_value }}</span>
                </td>
                <td class="px-4 py-3"><status-badge :status="t.status" /></td>
                <td class="px-4 py-3 text-gray-500 text-xs">{{ t.last_run ? new Date(t.last_run).toLocaleString() : '-' }}</td>
                <td class="px-4 py-3 text-xs max-w-xs truncate">{{ t.last_result || '-' }}</td>
              </tr>
            </tbody>
          </table>
          <div v-else class="p-8 text-center text-gray-400">No pipeline tasks</div>
        </div>
      </div>

      <!-- Token Usage Chart -->
      <div>
        <h2 class="text-sm font-semibold text-gray-500 uppercase mb-3">Token Usage (last 30 days)</h2>
        <div v-if="chartDays.length" class="bg-white dark:bg-gray-800 rounded-xl border border-gray-200 dark:border-gray-700 p-4 mb-4">
          <div class="overflow-x-auto">
            <svg :width="Math.max(chartDays.length * 36 + 70, 300)" height="160" class="block">
              <!-- Y axis labels -->
              <text v-for="(label, i) in chartYLabels" :key="'y'+i"
                :x="48" :y="20 + i * (120 / (chartYLabels.length - 1))"
                text-anchor="end" class="fill-gray-400" style="font-size:10px">{{ label }}</text>
              <!-- Grid lines -->
              <line v-for="(label, i) in chartYLabels" :key="'g'+i"
                :x1="54" :x2="Math.max(chartDays.length * 36 + 70, 300) - 4"
                :y1="20 + i * (120 / (chartYLabels.length - 1))"
                :y2="20 + i * (120 / (chartYLabels.length - 1))"
                stroke="currentColor" class="text-gray-200 dark:text-gray-700" stroke-width="0.5" />
              <!-- Stacked bars per day -->
              <g v-for="(day, di) in chartDays" :key="day.date">
                <rect v-for="(seg, si) in day.segments" :key="si"
                  :x="58 + di * 36" :y="140 - seg.y - seg.h" :width="28" :height="Math.max(seg.h, seg.tokens > 0 ? 1 : 0)"
                  :class="seg.color" rx="1">
                  <title>{{ seg.label }}&#10;{{ seg.tokens.toLocaleString() }} tokens ({{ seg.runs }} runs)</title>
                </rect>
                <!-- Date label -->
                <text :x="72 + di * 36" y="154" text-anchor="middle" class="fill-gray-400" style="font-size:9px"
                  v-if="chartDays.length <= 15 || di % Math.ceil(chartDays.length / 15) === 0">{{ day.date.slice(5) }}</text>
              </g>
            </svg>
          </div>
          <div class="flex items-center gap-4 mt-2 text-xs text-gray-400">
            <span class="flex items-center gap-1"><span class="inline-block w-3 h-3 rounded-sm fill-violet-500 bg-violet-500"></span> sanitiser</span>
            <span class="flex items-center gap-1"><span class="inline-block w-3 h-3 rounded-sm fill-blue-500 bg-blue-500"></span> monitor</span>
            <span class="flex items-center gap-1"><span class="inline-block w-3 h-3 rounded-sm fill-amber-500 bg-amber-500"></span> solver</span>
            <span class="flex items-center gap-1"><span class="inline-block w-3 h-3 rounded-sm fill-emerald-500 bg-emerald-500"></span> responder</span>
          </div>
        </div>

        <!-- Token Usage Table -->
        <div v-if="data.tokenUsage?.length" class="bg-white dark:bg-gray-800 rounded-xl border border-gray-200 dark:border-gray-700 overflow-hidden">
          <table class="w-full text-sm">
            <thead>
              <tr class="border-b border-gray-200 dark:border-gray-700">
                <th class="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase">Date</th>
                <th class="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase">Task</th>
                <th class="px-4 py-3 text-right text-xs font-medium text-gray-500 uppercase">Input</th>
                <th class="px-4 py-3 text-right text-xs font-medium text-gray-500 uppercase">Output</th>
                <th class="px-4 py-3 text-right text-xs font-medium text-gray-500 uppercase">Runs</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="(row, i) in data.tokenUsage" :key="i"
                class="border-b border-gray-100 dark:border-gray-700/50">
                <td class="px-4 py-3 text-gray-500">{{ row.date }}</td>
                <td class="px-4 py-3 font-mono text-xs">{{ row.task_id.replace('pipeline:', '') }}</td>
                <td class="px-4 py-3 text-right font-mono">{{ row.input_tokens.toLocaleString() }}</td>
                <td class="px-4 py-3 text-right font-mono">{{ row.output_tokens.toLocaleString() }}</td>
                <td class="px-4 py-3 text-right">{{ row.runs }}</td>
              </tr>
            </tbody>
          </table>
        </div>
        <div v-if="!data.tokenUsage?.length && !chartDays.length" class="text-sm text-gray-400">No token usage recorded yet</div>
      </div>
    </div>
  `,
  setup() {
    const data = ref({ tasks: [], sourceChannels: [], tokenUsage: [], teamGroup: null });

    const TASK_COLORS = {
      'pipeline:sanitiser': 'fill-violet-500',
      'pipeline:monitor': 'fill-blue-500',
      'pipeline:solver': 'fill-amber-500',
      'pipeline:responder': 'fill-emerald-500',
    };
    const TASK_ORDER = ['pipeline:sanitiser', 'pipeline:monitor', 'pipeline:solver', 'pipeline:responder'];

    const chartDays = computed(() => {
      const usage = data.value.tokenUsage || [];
      if (!usage.length) return [];
      // Group by date
      const byDate = new Map();
      for (const row of usage) {
        if (!byDate.has(row.date)) byDate.set(row.date, []);
        byDate.get(row.date).push(row);
      }
      return Array.from(byDate.entries()).map(([date, rows]) => {
        // Sort by task order, stack bottom-up
        rows.sort((a, b) => TASK_ORDER.indexOf(a.task_id) - TASK_ORDER.indexOf(b.task_id));
        let cumY = 0;
        const segments = rows.map(r => {
          const tokens = r.input_tokens + r.output_tokens;
          const h = chartMax.value > 0 ? Math.max((tokens / chartMax.value) * 120, tokens > 0 ? 1 : 0) : 0;
          const seg = { label: r.task_id.replace('pipeline:', ''), tokens, runs: r.runs, y: cumY, h, color: TASK_COLORS[r.task_id] || 'fill-gray-400' };
          cumY += h;
          return seg;
        });
        return { date, segments };
      });
    });

    const chartMax = computed(() => {
      const usage = data.value.tokenUsage || [];
      // Max total tokens per day
      const byDate = new Map();
      for (const row of usage) {
        const total = row.input_tokens + row.output_tokens;
        byDate.set(row.date, (byDate.get(row.date) || 0) + total);
      }
      return Math.max(...Array.from(byDate.values()), 1);
    });

    const chartYLabels = computed(() => {
      const max = chartMax.value;
      if (max >= 1000000) return [Math.round(max / 1000000) + 'M', Math.round(max / 2000000) + 'M', '0'];
      if (max >= 1000) return [Math.round(max / 1000) + 'k', Math.round(max / 2000) + 'k', '0'];
      return [String(max), String(Math.round(max / 2)), '0'];
    });

    const fetch = async () => {
      try { data.value = await api('/pipeline'); } catch {}
    };

    onMounted(fetch);
    const interval = setInterval(fetch, 15000);
    onUnmounted(() => clearInterval(interval));

    return { data, chartDays, chartYLabels, chartMax, window };
  },
};

// Events + Intake page
const AppEvents = {
  template: `
    <div>
      <h1 class="text-2xl font-bold mb-6">Events</h1>

      <div class="mb-6">
        <tab-bar :tabs="tabs" :active="activeTab" @select="activeTab = $event" />
      </div>

      <!-- Events Tab -->
      <div v-if="activeTab === 'events'">
        <div class="mb-4 flex gap-3 items-end">
          <div>
            <label class="block text-xs font-medium mb-1">Status</label>
            <select v-model="statusFilter" @change="fetchEvents"
              class="px-3 py-1.5 rounded-lg border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-800 text-sm">
              <option value="">All</option>
              <option value="pending">Pending</option>
              <option value="claimed">Claimed</option>
              <option value="done">Done</option>
              <option value="failed">Failed</option>
            </select>
          </div>
          <button @click="fetchEvents" class="px-3 py-1.5 bg-gray-200 dark:bg-gray-700 rounded-lg text-sm hover:bg-gray-300 dark:hover:bg-gray-600 transition-colors">Refresh</button>
        </div>
        <div class="bg-white dark:bg-gray-800 rounded-xl border border-gray-200 dark:border-gray-700 overflow-hidden">
          <table v-if="events.length" class="w-full text-sm">
            <thead>
              <tr class="border-b border-gray-200 dark:border-gray-700">
                <th class="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase">ID</th>
                <th class="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase">Type</th>
                <th class="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase">Source</th>
                <th class="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase">Status</th>
                <th class="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase">Created</th>
                <th class="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase">Claimed By</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="e in events" :key="e.id" @click="toggleExpand(e.id)"
                class="border-b border-gray-100 dark:border-gray-700/50 hover:bg-gray-50 dark:hover:bg-gray-750 cursor-pointer">
                <td class="px-4 py-3 text-gray-500">{{ e.id }}</td>
                <td class="px-4 py-3 font-mono text-xs">{{ e.type }}</td>
                <td class="px-4 py-3">{{ e.source_group }}</td>
                <td class="px-4 py-3"><status-badge :status="e.status" /></td>
                <td class="px-4 py-3 text-gray-500 text-xs">{{ formatTime(e.created_at) }}</td>
                <td class="px-4 py-3 text-gray-500 text-xs">{{ e.claimed_by || '-' }}</td>
              </tr>
              <tr v-if="expanded.has(events.find(e2 => expanded.has(e2.id))?.id)" v-for="e in events.filter(e2 => expanded.has(e2.id))" :key="'detail-'+e.id">
                <td colspan="6" class="px-4 py-3 bg-gray-50 dark:bg-gray-900">
                  <pre class="text-xs overflow-x-auto whitespace-pre-wrap font-mono">{{ formatPayload(e.payload) }}</pre>
                  <div v-if="e.result_note" class="mt-2 text-xs text-gray-500">Note: {{ e.result_note }}</div>
                </td>
              </tr>
            </tbody>
          </table>
          <div v-else class="p-8 text-center text-gray-400">No events found</div>
        </div>
      </div>

      <!-- Intake Tab -->
      <div v-if="activeTab === 'intake'">
        <div class="mb-4 flex gap-3 items-end">
          <label class="flex items-center gap-2 text-sm">
            <input type="checkbox" v-model="showProcessed" @change="fetchIntakeLogs" class="w-4 h-4 rounded">
            Show processed
          </label>
          <button @click="fetchIntakeLogs" class="px-3 py-1.5 bg-gray-200 dark:bg-gray-700 rounded-lg text-sm hover:bg-gray-300 dark:hover:bg-gray-600 transition-colors">Refresh</button>
        </div>
        <div class="bg-white dark:bg-gray-800 rounded-xl border border-gray-200 dark:border-gray-700 overflow-hidden">
          <table v-if="intakeLogs.length" class="w-full text-sm">
            <thead>
              <tr class="border-b border-gray-200 dark:border-gray-700">
                <th class="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase">ID</th>
                <th class="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase">Source Group</th>
                <th class="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase">Task</th>
                <th class="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase">Reason</th>
                <th class="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase">Submitted</th>
                <th class="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase">Status</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="l in intakeLogs" :key="l.id"
                class="border-b border-gray-100 dark:border-gray-700/50">
                <td class="px-4 py-3 text-gray-500">{{ l.id }}</td>
                <td class="px-4 py-3">{{ l.source_group }}</td>
                <td class="px-4 py-3 font-mono text-xs">{{ l.source_task_id || '-' }}</td>
                <td class="px-4 py-3">{{ l.reason }}</td>
                <td class="px-4 py-3 text-gray-500 text-xs">{{ formatTime(l.submitted_at) }}</td>
                <td class="px-4 py-3">
                  <span v-if="l.processed_at" class="text-green-600 dark:text-green-400 text-xs">Processed</span>
                  <span v-else class="text-yellow-600 dark:text-yellow-400 text-xs">Pending</span>
                </td>
              </tr>
            </tbody>
          </table>
          <div v-else class="p-8 text-center text-gray-400">No intake logs found</div>
        </div>
      </div>
    </div>
  `,
  setup() {
    const events = ref([]);
    const intakeLogs = ref([]);
    const activeTab = ref('events');
    const statusFilter = ref('');
    const showProcessed = ref(true);
    const expanded = ref(new Set());

    const tabs = [
      { key: 'events', label: 'Events' },
      { key: 'intake', label: 'Intake Log' },
    ];

    const fetchEvents = async () => {
      try {
        const params = new URLSearchParams();
        if (statusFilter.value) params.set('status', statusFilter.value);
        params.set('limit', '100');
        events.value = await api(`/events?${params}`);
      } catch {}
    };

    const fetchIntakeLogs = async () => {
      try {
        const params = new URLSearchParams();
        params.set('includeProcessed', String(showProcessed.value));
        params.set('limit', '100');
        intakeLogs.value = await api(`/intake-logs?${params}`);
      } catch {}
    };

    const toggleExpand = (id) => {
      if (expanded.value.has(id)) expanded.value.delete(id);
      else expanded.value.add(id);
      expanded.value = new Set(expanded.value); // trigger reactivity
    };

    const formatPayload = (json) => {
      try { return JSON.stringify(JSON.parse(json), null, 2); }
      catch { return json; }
    };

    const formatTime = (iso) => {
      if (!iso) return '-';
      return new Date(iso).toLocaleString();
    };

    onMounted(() => {
      fetchEvents();
      fetchIntakeLogs();
    });
    const interval = setInterval(() => { fetchEvents(); fetchIntakeLogs(); }, 10000);
    onUnmounted(() => clearInterval(interval));

    return { events, intakeLogs, activeTab, tabs, statusFilter, showProcessed, expanded, fetchEvents, fetchIntakeLogs, toggleExpand, formatPayload, formatTime };
  },
};

// Observations list
const AppObservations = {
  template: `
    <div>
      <h1 class="text-2xl font-bold mb-6">Observations</h1>
      <div class="mb-4 flex flex-wrap gap-3 items-end">
        <div>
          <label class="block text-xs font-medium mb-1">Source Type</label>
          <select v-model="sourceType" @change="fetch"
            class="px-3 py-1.5 rounded-lg border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-800 text-sm">
            <option value="">All</option>
            <option value="passive_channel">Passive</option>
            <option value="task_intake">Intake</option>
          </select>
        </div>
        <div>
          <label class="block text-xs font-medium mb-1">Label Status</label>
          <select v-model="labelFilter" @change="fetch"
            class="px-3 py-1.5 rounded-lg border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-800 text-sm">
            <option value="">All</option>
            <option value="true">Labelled</option>
            <option value="false">Unlabelled</option>
          </select>
        </div>
        <button @click="fetch" class="px-3 py-1.5 bg-gray-200 dark:bg-gray-700 rounded-lg text-sm hover:bg-gray-300 dark:hover:bg-gray-600 transition-colors">Refresh</button>
      </div>
      <div class="bg-white dark:bg-gray-800 rounded-xl border border-gray-200 dark:border-gray-700 overflow-hidden">
        <table v-if="observations.length" class="w-full text-sm">
          <thead>
            <tr class="border-b border-gray-200 dark:border-gray-700">
              <th class="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase">ID</th>
              <th class="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase">Source</th>
              <th class="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase">Type</th>
              <th class="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase">Text</th>
              <th class="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase">Label</th>
              <th class="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase">Created</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="o in observations" :key="o.id"
              @click="window.location.hash = '#/observations/' + o.id"
              class="border-b border-gray-100 dark:border-gray-700/50 hover:bg-gray-50 dark:hover:bg-gray-750 cursor-pointer">
              <td class="px-4 py-3 text-gray-500">{{ o.id }}</td>
              <td class="px-4 py-3 font-mono text-xs">{{ o.source_chat_jid || o.source_type }}</td>
              <td class="px-4 py-3">
                <span :class="o.source_type === 'passive_channel' ? 'bg-blue-100 text-blue-800 dark:bg-blue-900 dark:text-blue-200' : 'bg-purple-100 text-purple-800 dark:bg-purple-900 dark:text-purple-200'"
                  class="px-2 py-0.5 rounded-full text-xs font-medium">{{ o.source_type === 'passive_channel' ? 'passive' : 'intake' }}</span>
              </td>
              <td class="px-4 py-3 max-w-xs truncate">{{ o.raw_text }}</td>
              <td class="px-4 py-3">
                <span v-if="o.has_label" class="text-green-600 dark:text-green-400 text-xs font-medium">Labelled</span>
                <span v-else class="text-gray-400 text-xs">-</span>
              </td>
              <td class="px-4 py-3 text-gray-500 text-xs">{{ new Date(o.created_at).toLocaleString() }}</td>
            </tr>
          </tbody>
        </table>
        <div v-else class="p-8 text-center text-gray-400">No observations found</div>
      </div>
      <div v-if="observations.length >= pageSize" class="mt-4 flex gap-2">
        <button v-if="page > 0" @click="page--; fetch()" class="px-3 py-1.5 bg-gray-200 dark:bg-gray-700 rounded-lg text-sm">Previous</button>
        <button @click="page++; fetch()" class="px-3 py-1.5 bg-gray-200 dark:bg-gray-700 rounded-lg text-sm">Next</button>
      </div>
    </div>
  `,
  setup() {
    const observations = ref([]);
    const sourceType = ref('');
    const labelFilter = ref('');
    const page = ref(0);
    const pageSize = 50;

    const fetch = async () => {
      try {
        const params = new URLSearchParams();
        if (sourceType.value) params.set('sourceType', sourceType.value);
        if (labelFilter.value) params.set('labelled', labelFilter.value);
        params.set('limit', String(pageSize));
        params.set('offset', String(page.value * pageSize));
        observations.value = await api(`/observations?${params}`);
      } catch {}
    };

    onMounted(fetch);
    const interval = setInterval(fetch, 10000);
    onUnmounted(() => clearInterval(interval));
    return { observations, sourceType, labelFilter, page, pageSize, fetch, window };
  },
};

// Observation detail + labelling
const AppObservationDetail = {
  props: ['observationId'],
  template: `
    <div v-if="!loading && obs">
      <div class="mb-4">
        <a href="#/observations" class="text-blue-600 hover:text-blue-700 text-sm flex items-center gap-1">
          <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">${icons.back}</svg>
          Back to observations
        </a>
      </div>
      <h1 class="text-2xl font-bold mb-6">Observation #{{ obs.id }}</h1>

      <div class="grid grid-cols-1 lg:grid-cols-2 gap-6">
        <!-- Left: raw text -->
        <div class="bg-white dark:bg-gray-800 rounded-xl border border-gray-200 dark:border-gray-700 p-4">
          <h2 class="text-sm font-semibold mb-2 text-gray-500 uppercase">Raw Message</h2>
          <div class="text-sm whitespace-pre-wrap font-mono bg-gray-50 dark:bg-gray-900 rounded-lg p-3 max-h-96 overflow-y-auto">{{ obs.raw_text }}</div>
          <div class="mt-3 text-xs text-gray-500 space-y-1">
            <div>Source: <span class="font-mono">{{ obs.source_chat_jid || obs.source_type }}</span></div>
            <div>Created: {{ new Date(obs.created_at).toLocaleString() }}</div>
            <div v-if="obs.source_task_id">Task: <span class="font-mono">{{ obs.source_task_id }}</span></div>
            <div v-if="obs.intake_reason">Reason: {{ obs.intake_reason }}</div>
          </div>
        </div>

        <!-- Right: label form -->
        <div class="bg-white dark:bg-gray-800 rounded-xl border border-gray-200 dark:border-gray-700 p-4">
          <h2 class="text-sm font-semibold mb-3 text-gray-500 uppercase">Label</h2>
          <div class="space-y-3">
            <div>
              <label class="block text-xs font-medium mb-1">Intent</label>
              <select v-model="form.intent" class="w-full px-3 py-1.5 rounded-lg border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-800 text-sm">
                <option value="">-</option>
                <option value="bug_report">Bug report</option>
                <option value="status_update">Status update</option>
                <option value="question">Question</option>
                <option value="fyi">FYI</option>
                <option value="banter">Banter</option>
                <option value="direct_to_bot">Direct to bot</option>
              </select>
            </div>
            <div>
              <label class="block text-xs font-medium mb-1">Form</label>
              <select v-model="form.form" class="w-full px-3 py-1.5 rounded-lg border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-800 text-sm">
                <option value="">-</option>
                <option value="free_prose">Free prose</option>
                <option value="code_block">Code block</option>
                <option value="screenshot_reference">Screenshot reference</option>
                <option value="link_dump">Link dump</option>
                <option value="quoted_text">Quoted text</option>
              </select>
            </div>
            <div>
              <label class="block text-xs font-medium mb-1">Imperative Content</label>
              <select v-model="form.imperativeContent" class="w-full px-3 py-1.5 rounded-lg border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-800 text-sm">
                <option value="">-</option>
                <option value="none">None</option>
                <option value="soft">Soft</option>
                <option value="direct">Direct</option>
                <option value="urgent">Urgent</option>
              </select>
            </div>
            <div>
              <label class="block text-xs font-medium mb-1">Addressee</label>
              <select v-model="form.addressee" class="w-full px-3 py-1.5 rounded-lg border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-800 text-sm">
                <option value="">-</option>
                <option value="nobody">Nobody specific</option>
                <option value="specific_human">Specific human</option>
                <option value="channel">Channel at large</option>
                <option value="bot">Bot / assistant</option>
              </select>
            </div>
            <div>
              <label class="block text-xs font-medium mb-1">Embedded Instructions</label>
              <select v-model="form.embeddedInstructions" class="w-full px-3 py-1.5 rounded-lg border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-800 text-sm">
                <option value="">-</option>
                <option value="none">None</option>
                <option value="quoted_message">Quoted message</option>
                <option value="error_trace">Error trace</option>
                <option value="ai_generated">AI-generated</option>
                <option value="code_content">Code content</option>
              </select>
            </div>
            <div>
              <label class="flex items-center gap-2 text-sm cursor-pointer">
                <input type="checkbox" v-model="form.adversarialSmell" class="w-4 h-4 rounded border-gray-300 text-blue-600">
                Adversarial smell
              </label>
            </div>
            <div>
              <label class="block text-xs font-medium mb-1">Notes</label>
              <textarea v-model="form.notes" rows="2" class="w-full px-3 py-1.5 rounded-lg border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-800 text-sm"></textarea>
            </div>
            <div>
              <label class="block text-xs font-medium mb-1">Expected JSON (golden label)</label>
              <textarea v-model="form.expectedJson" rows="4" placeholder='{"fact_summary":"...","urgency":"..."}'
                class="w-full px-3 py-1.5 rounded-lg border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-800 text-sm font-mono"></textarea>
            </div>
            <button @click="saveLabel" :disabled="saving"
              class="px-4 py-2 bg-blue-600 hover:bg-blue-700 disabled:opacity-50 text-white rounded-lg text-sm font-medium transition-colors">
              {{ saving ? 'Saving...' : 'Save Label' }}
            </button>
          </div>
        </div>
      </div>

      <!-- Sanitised output -->
      <div v-if="obs.sanitised_json" class="mt-6 bg-white dark:bg-gray-800 rounded-xl border border-gray-200 dark:border-gray-700 p-4">
        <h2 class="text-sm font-semibold mb-2 text-gray-500 uppercase">Sanitised Output</h2>
        <pre class="text-xs font-mono bg-gray-50 dark:bg-gray-900 rounded-lg p-3 overflow-x-auto whitespace-pre-wrap">{{ formatJson(obs.sanitised_json) }}</pre>
      </div>

      <!-- Navigation -->
      <div class="mt-4 flex gap-2">
        <button v-if="obs.id > 1" @click="navigate(obs.id - 1)" class="px-3 py-1.5 bg-gray-200 dark:bg-gray-700 rounded-lg text-sm">Previous</button>
        <button @click="navigate(obs.id + 1)" class="px-3 py-1.5 bg-gray-200 dark:bg-gray-700 rounded-lg text-sm">Next</button>
      </div>
    </div>
    <div v-else-if="loading" class="text-center py-20 text-gray-400">Loading...</div>
    <div v-else class="text-center py-20 text-gray-400">Observation not found</div>
  `,
  setup(props) {
    const obs = ref(null);
    const loading = ref(true);
    const saving = ref(false);
    const form = Vue.reactive({
      intent: '', form: '', imperativeContent: '', addressee: '',
      embeddedInstructions: '', adversarialSmell: false, notes: '', expectedJson: '',
    });

    const fetchObs = async () => {
      loading.value = true;
      try {
        const data = await api(`/observations/${props.observationId}`);
        obs.value = data;
        if (data.label) {
          form.intent = data.label.intent || '';
          form.form = data.label.form || '';
          form.imperativeContent = data.label.imperative_content || '';
          form.addressee = data.label.addressee || '';
          form.embeddedInstructions = data.label.embedded_instructions || '';
          form.adversarialSmell = data.label.adversarial_smell === 1;
          form.notes = data.label.notes || '';
          form.expectedJson = data.label.expected_json || '';
        }
      } catch { obs.value = null; }
      loading.value = false;
    };

    const saveLabel = async () => {
      saving.value = true;
      try {
        await api(`/observations/${props.observationId}/label`, { method: 'PATCH', body: form });
        showToast('Label saved');
      } catch (e) { showToast(e.message, 'error'); }
      saving.value = false;
    };

    const navigate = (id) => { window.location.hash = `#/observations/${id}`; };

    const formatJson = (json) => {
      try { return JSON.stringify(JSON.parse(json), null, 2); }
      catch { return json; }
    };

    onMounted(fetchObs);
    return { obs, loading, saving, form, saveLabel, navigate, formatJson };
  },
};

const app = createApp({
  template: `
    <div class="flex h-screen overflow-hidden">
      <!-- Mobile menu button -->
      <button @click="sidebarOpen = !sidebarOpen"
        class="fixed top-4 left-4 z-50 md:hidden p-2 rounded-lg bg-gray-900 text-white shadow-lg">
        <svg class="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">${icons.menu}</svg>
      </button>

      <app-sidebar
        :groups="groups"
        :current-hash="currentHash"
        :active-group-folder="activeGroupFolder"
        :open="sidebarOpen"
        :dark-mode="darkMode"
        @toggle="sidebarOpen = !sidebarOpen"
        @toggle-dark="toggleDark" />

      <main class="flex-1 overflow-y-auto p-6 md:p-8 pt-16 md:pt-8">
        <div class="max-w-4xl">
          <app-dashboard v-if="route.view === 'dashboard'" :groups="groups" />
          <app-global-prompts v-if="route.view === 'global-prompts'" />
          <app-events v-if="route.view === 'events'" />
          <app-pipeline v-if="route.view === 'pipeline'" />
          <app-observations v-if="route.view === 'observations'" />
          <app-observation-detail v-if="route.view === 'observation-detail'" :observation-id="route.id" :key="route.id" />
          <app-group-detail v-if="route.view === 'group-detail'" :folder="route.folder" :initial-tab="route.tab" :key="route.folder + (route.tab || '')" />
          <app-task-detail v-if="route.view === 'task-detail'" :task-id="route.id" :key="route.id" @group-loaded="taskGroupFolder = $event" />
          <div v-if="route.view === 'not-found'" class="text-center py-20 text-gray-400">
            <p class="text-lg">Page not found</p>
          </div>
        </div>
      </main>

      <app-toast />
    </div>
  `,
  setup() {
    const currentHash = ref(window.location.hash.slice(1) || '/');
    const groups = ref([]);
    const sidebarOpen = ref(false);
    const darkMode = ref(document.documentElement.classList.contains('dark'));
    const taskGroupFolder = ref('');

    const route = computed(() => {
      const [path, qs] = currentHash.value.split('?');
      const params = new URLSearchParams(qs || '');
      if (path === '/') return { view: 'dashboard' };
      if (path === '/prompts/global') return { view: 'global-prompts' };
      if (path === '/events') return { view: 'events' };
      if (path === '/pipeline') return { view: 'pipeline' };
      if (path === '/observations') return { view: 'observations' };
      const om = path.match(/^\/observations\/(\d+)$/);
      if (om) return { view: 'observation-detail', id: parseInt(om[1], 10) };
      const gm = path.match(/^\/groups\/([^/]+)$/);
      if (gm) return { view: 'group-detail', folder: gm[1], tab: params.get('tab') };
      const tm = path.match(/^\/tasks\/([^/]+)$/);
      if (tm) return { view: 'task-detail', id: tm[1] };
      return { view: 'not-found' };
    });

    const activeGroupFolder = computed(() => {
      if (route.value.view === 'group-detail') return route.value.folder;
      // Only highlight a group when viewing a non-pipeline task detail
      if (route.value.view === 'task-detail' && !route.value.id?.startsWith('pipeline:')) return taskGroupFolder.value;
      return '';
    });

    // Close sidebar on navigation (mobile)
    watch(currentHash, () => { sidebarOpen.value = false; });

    const onHashChange = () => {
      currentHash.value = window.location.hash.slice(1) || '/';
    };

    const toggleDark = () => {
      darkMode.value = !darkMode.value;
      document.documentElement.classList.toggle('dark', darkMode.value);
      localStorage.setItem('nanoclaw-theme', darkMode.value ? 'dark' : 'light');
    };

    onMounted(() => {
      window.addEventListener('hashchange', onHashChange);
      api('/groups').then(g => groups.value = g).catch(() => {});
    });

    onUnmounted(() => {
      window.removeEventListener('hashchange', onHashChange);
    });

    return { currentHash, groups, route, sidebarOpen, darkMode, toggleDark, taskGroupFolder, activeGroupFolder };
  },
});

// Register components
app.component('app-sidebar', AppSidebar);
app.component('app-toast', AppToast);
app.component('app-dashboard', AppDashboard);
app.component('app-global-prompts', AppGlobalPrompts);
app.component('app-group-detail', AppGroupDetail);
app.component('app-task-detail', AppTaskDetail);
app.component('app-events', AppEvents);
app.component('app-pipeline', AppPipeline);
app.component('app-observations', AppObservations);
app.component('app-observation-detail', AppObservationDetail);
app.component('tab-bar', TabBar);
app.component('status-badge', StatusBadge);

// Mount
app.mount('#app');
