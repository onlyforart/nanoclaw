# Plan: Vue 3 + TailwindCSS Frontend Redesign

## Context

The current web UI frontend is vanilla JS with custom CSS. It works but looks generic and the Group Detail / Task Detail pages are long vertical scrolls. The user wants:
- TailwindCSS for styling (via CDN, no build step)
- Vue 3 for reactivity (via CDN, no build step)
- Improved sidebar aesthetics
- Tabbed navigation within Group Detail and Task Detail views

## Files to Modify

| File | Change |
|------|--------|
| `webui/public/index.html` | Rewrite — add Vue 3 + Tailwind CDN, mount point, dark mode init |
| `webui/public/app.js` | Rewrite — Vue 3 Composition API with components |
| `webui/public/style.css` | Reduce to ~20 lines (tab-size, toast keyframes, scrollbar) |

No backend changes needed. The server.ts static file serving is unchanged.

## Architecture

**CDN scripts (no build step):**
```html
<script src="https://unpkg.com/vue@3/dist/vue.global.prod.js"></script>
<script src="https://cdn.tailwindcss.com"></script>
```

**Vue app structure:** Single `createApp()` with Composition API. Components registered via `app.component()` with template strings. Hash-based routing via reactive `ref` tracking `window.location.hash`.

## Component Hierarchy

```
Root App
├── app-sidebar          — Left nav: Dashboard, Global Prompts, Groups list, dark mode toggle
├── app-toast            — Fixed bottom-right notification
├── app-dashboard        — Health, containers (5s auto-refresh), groups table
├── app-global-prompts   — Two textareas + save
├── app-group-detail     — TABBED: Settings | Prompts | Tasks
├── app-task-detail      — TABBED: Prompt | Settings | Run History
├── app-tab-bar          — Reusable tab component (used by group-detail, task-detail)
└── status-badge         — Reusable status pill (active/paused/error/success)
```

## Tab Layout

**Group Detail** (`#/groups/{folder}`):
- **Settings** tab — model, maxToolRounds, timeoutMs form + save
- **Prompts** tab — CLAUDE.md textarea, OLLAMA.md textarea + save
- **Tasks** tab — scheduled tasks table (clickable rows → task detail)

**Task Detail** (`#/tasks/{id}`):
- **Prompt** tab — prompt textarea + save, context mode (read-only)
- **Settings** tab — schedule, model, timezone, limits, status + save
- **Run History** tab — recent runs table

## Sidebar Improvements

- Active item: left blue border accent + highlighted bg
- Group count badge
- Hover transitions (`hover:bg-white/10`)
- Dark mode toggle (sun/moon) at bottom
- Mobile: hamburger toggle, slide-over overlay

## Dark Mode

- Tailwind `darkMode: 'class'` with both system preference detection and manual toggle
- Inline `<script>` in `<head>` sets `dark` class before paint to prevent flash
- Toggle persists to `localStorage`

## Implementation Steps

1. **index.html** — CDN scripts, Tailwind config, dark mode init, Vue mount point
2. **app.js — API layer + router** — port `api()`, create Vue app with hash routing
3. **app.js — app-sidebar** — styled nav with Tailwind
4. **app.js — app-toast, status-badge** — utility components
5. **app.js — app-tab-bar** — reusable tab component
6. **app.js — app-dashboard** — health, containers, groups
7. **app.js — app-global-prompts** — textarea editors
8. **app.js — app-group-detail** — tabbed: settings, prompts, tasks
9. **app.js — app-task-detail** — tabbed: prompt, settings, runs
10. **style.css** — trim to minimal custom styles
11. **Test** — all routes, API calls, dark mode, mobile responsive

## Verification

1. Start the server: `npx tsx webui/start.ts`
2. Visit https://localhost:3100 — dashboard loads, groups listed, containers refresh
3. Click a group → tabbed view with Settings/Prompts/Tasks tabs
4. Edit and save a prompt → toast confirmation, file updated
5. Click a task → tabbed view with Prompt/Settings/Run History tabs
6. Toggle dark mode → persists across page reload
7. Resize to mobile width → sidebar collapses, hamburger menu works
8. Run `npx vitest run webui/` → all 113 backend tests still pass
