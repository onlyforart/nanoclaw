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
  props: ['groups', 'currentHash', 'open', 'darkMode'],
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
      return props.currentHash === path || props.currentHash.startsWith(path + '/');
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
        <tab-bar :tabs="tabs" :active="activeTab" @select="activeTab = $event" />

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
                <label class="block text-sm font-medium mb-1">Max Tool Rounds</label>
                <input v-model.number="form.maxToolRounds" type="number"
                  class="w-full px-3 py-2 rounded-lg border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-800 text-sm focus:ring-2 focus:ring-blue-500 focus:border-blue-500 outline-none transition">
              </div>
            </div>
            <div class="mb-4">
              <label class="block text-sm font-medium mb-1">Timeout (ms)</label>
              <input v-model.number="form.timeoutMs" type="number"
                class="w-full md:w-1/2 px-3 py-2 rounded-lg border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-800 text-sm focus:ring-2 focus:ring-blue-500 focus:border-blue-500 outline-none transition">
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
    const activeTab = ref(props.initialTab || 'settings');
    let taskInterval = null;

    const form = Vue.reactive({ model: '', maxToolRounds: null, timeoutMs: null });

    const tabs = computed(() => [
      { key: 'settings', label: 'Settings' },
      { key: 'prompts', label: 'Prompts' },
      { key: 'tasks', label: 'Tasks', count: tasks.value.length },
    ]);

    const fetchTasks = async () => {
      try { tasks.value = await api(`/groups/${props.folder}/tasks`); } catch {}
    };

    onMounted(async () => {
      try {
        const [g, p, t] = await Promise.all([
          api(`/groups/${props.folder}`),
          api(`/groups/${props.folder}/prompts`),
          api(`/groups/${props.folder}/tasks`),
        ]);
        group.value = g;
        form.model = g.model || '';
        form.maxToolRounds = g.maxToolRounds;
        form.timeoutMs = g.timeoutMs;
        claude.value = p.claude;
        ollama.value = p.ollama || '';
        tasks.value = t;
      } catch (e) { showToast(e.message, 'error'); }
      loading.value = false;
      taskInterval = setInterval(fetchTasks, 10000);
    });

    onUnmounted(() => { if (taskInterval) clearInterval(taskInterval); });

    const saveSettings = async () => {
      saving.value = true;
      try {
        const body = {};
        if (form.model) body.model = form.model;
        if (form.maxToolRounds != null) body.maxToolRounds = form.maxToolRounds;
        if (form.timeoutMs != null) body.timeoutMs = form.timeoutMs;
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

    const navigate = (path) => { window.location.hash = path; };

    return { group, tasks, claude, ollama, loading, saving, activeTab, form, tabs, saveSettings, savePrompts, navigate };
  },
};

// Task Detail (Tabbed)
const AppTaskDetail = {
  props: ['taskId'],
  template: `
    <div>
      <!-- Back link -->
      <a v-if="task" :href="'#/groups/' + task.groupFolder + '?tab=tasks'" class="inline-flex items-center gap-1 text-sm text-gray-400 hover:text-gray-600 dark:hover:text-gray-300 mb-4 transition-colors">
        <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">${icons.back}</svg>
        Back to group
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
          <p class="mt-4 text-xs text-gray-400">Context mode: <span class="font-mono">{{ task.contextMode }}</span> (read-only)</p>
        </div>

        <!-- Settings Tab -->
        <div v-if="activeTab === 'settings'">
          <div class="bg-white dark:bg-gray-800 rounded-xl border border-gray-200 dark:border-gray-700 p-6">
            <div class="grid grid-cols-1 md:grid-cols-2 gap-4 mb-4">
              <div>
                <label class="block text-sm font-medium mb-1">Schedule Type</label>
                <input v-model="form.scheduleType" type="text"
                  class="w-full px-3 py-2 rounded-lg border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-800 text-sm focus:ring-2 focus:ring-blue-500 focus:border-blue-500 outline-none transition">
              </div>
              <div>
                <label class="block text-sm font-medium mb-1">Schedule Value</label>
                <input v-model="form.scheduleValue" type="text"
                  class="w-full px-3 py-2 rounded-lg border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-800 font-mono text-sm focus:ring-2 focus:ring-blue-500 focus:border-blue-500 outline-none transition">
              </div>
            </div>
            <div class="grid grid-cols-1 md:grid-cols-2 gap-4 mb-4">
              <div>
                <label class="block text-sm font-medium mb-1">Model</label>
                <input v-model="form.model" type="text"
                  class="w-full px-3 py-2 rounded-lg border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-800 text-sm focus:ring-2 focus:ring-blue-500 focus:border-blue-500 outline-none transition">
              </div>
              <div>
                <label class="block text-sm font-medium mb-1">Timezone</label>
                <input v-model="form.timezone" type="text"
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
              <label class="block text-sm font-medium mb-1">Status</label>
              <select v-model="form.status"
                class="w-full md:w-1/2 px-3 py-2 rounded-lg border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-800 text-sm focus:ring-2 focus:ring-blue-500 focus:border-blue-500 outline-none transition">
                <option value="active">Active</option>
                <option value="paused">Paused</option>
              </select>
            </div>
            <button @click="save" :disabled="saving"
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
      </div>
    </div>
  `,
  setup(props) {
    const task = ref(null);
    const runs = ref([]);
    const promptText = ref('');
    const loading = ref(true);
    const saving = ref(false);
    const activeTab = ref('prompt');

    const form = Vue.reactive({
      scheduleType: '', scheduleValue: '', model: '', timezone: '',
      maxToolRounds: null, timeoutMs: null, status: 'active',
    });

    const tabs = computed(() => [
      { key: 'prompt', label: 'Prompt' },
      { key: 'settings', label: 'Settings' },
      { key: 'runs', label: 'Run History', count: runs.value.length },
    ]);

    onMounted(async () => {
      try {
        const [t, r] = await Promise.all([
          api(`/tasks/${props.taskId}`),
          api(`/tasks/${props.taskId}/runs?limit=20`),
        ]);
        task.value = t;
        promptText.value = t.prompt;
        form.scheduleType = t.scheduleType;
        form.scheduleValue = t.scheduleValue;
        form.model = t.model || '';
        form.timezone = t.timezone || '';
        form.maxToolRounds = t.maxToolRounds;
        form.timeoutMs = t.timeoutMs;
        form.status = t.status;
        runs.value = r;
      } catch (e) { showToast(e.message, 'error'); }
      loading.value = false;
    });

    const save = async () => {
      saving.value = true;
      try {
        const body = { prompt: promptText.value };
        if (form.scheduleType) body.scheduleType = form.scheduleType;
        if (form.scheduleValue) body.scheduleValue = form.scheduleValue;
        if (form.model) body.model = form.model;
        if (form.timezone) body.timezone = form.timezone;
        if (form.maxToolRounds != null) body.maxToolRounds = form.maxToolRounds;
        if (form.timeoutMs != null) body.timeoutMs = form.timeoutMs;
        body.status = form.status;
        const updated = await api(`/tasks/${props.taskId}`, { method: 'PATCH', body });
        task.value = updated;
        showToast('Task saved');
      } catch (e) { showToast(e.message, 'error'); }
      saving.value = false;
    };

    return { task, runs, promptText, loading, saving, activeTab, form, tabs, save };
  },
};

// ── App ────────────────────────────────────────────────────

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
        :open="sidebarOpen"
        :dark-mode="darkMode"
        @toggle="sidebarOpen = !sidebarOpen"
        @toggle-dark="toggleDark" />

      <main class="flex-1 overflow-y-auto p-6 md:p-8 pt-16 md:pt-8">
        <div class="max-w-4xl">
          <app-dashboard v-if="route.view === 'dashboard'" :groups="groups" />
          <app-global-prompts v-if="route.view === 'global-prompts'" />
          <app-group-detail v-if="route.view === 'group-detail'" :folder="route.folder" :initial-tab="route.tab" :key="route.folder + (route.tab || '')" />
          <app-task-detail v-if="route.view === 'task-detail'" :task-id="route.id" :key="route.id" />
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

    const route = computed(() => {
      const [path, qs] = currentHash.value.split('?');
      const params = new URLSearchParams(qs || '');
      if (path === '/') return { view: 'dashboard' };
      if (path === '/prompts/global') return { view: 'global-prompts' };
      const gm = path.match(/^\/groups\/([^/]+)$/);
      if (gm) return { view: 'group-detail', folder: gm[1], tab: params.get('tab') };
      const tm = path.match(/^\/tasks\/([^/]+)$/);
      if (tm) return { view: 'task-detail', id: tm[1] };
      return { view: 'not-found' };
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

    return { currentHash, groups, route, sidebarOpen, darkMode, toggleDark };
  },
});

// Register components
app.component('app-sidebar', AppSidebar);
app.component('app-toast', AppToast);
app.component('app-dashboard', AppDashboard);
app.component('app-global-prompts', AppGlobalPrompts);
app.component('app-group-detail', AppGroupDetail);
app.component('app-task-detail', AppTaskDetail);
app.component('tab-bar', TabBar);
app.component('status-badge', StatusBadge);

// Mount
app.mount('#app');
