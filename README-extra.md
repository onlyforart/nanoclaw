# Fork-Specific Notes (v2)

This is the v2-shaped fork-extras doc. It documents constraints and
customisations that differ from upstream NanoClaw v2 and live in this
fork only. The pre-v2 (v1) version of this file at the same path
contained additional v1-only sections (router_state semantics, dual
container slots, scheduled_tasks helpers, etc.) that no longer apply
after the K.1.h cutover — they have been intentionally dropped here.
The pre-cutover backup retains the full v1 file.

## Upstream pull / merge

To pull upstream changes: `git fetch upstream && git merge upstream/main`
— but expect to hand-resolve conflicts in fork-customised areas
(notably `src/channels/slack.ts` — keep the fork version).

## Slack: Socket Mode is mandatory (do NOT run install-slack.sh)

This fork uses the **v1 Socket Mode** Slack adapter (`@slack/bolt` via
`src/channels/slack.ts` + `src/channels/slack-bolt-shim.ts`). Upstream
NanoClaw v2 ships a webhook-only Chat-SDK shim (`@chat-adapter/slack`)
delivered via the `channels` branch; this fork deliberately does NOT
follow that change.

**Why Socket Mode:** the upstream webhook path requires a public
ingress (Slack's Events API posting back to our host). This install is
behind network boundaries that don't expose a public ingress. Socket
Mode uses an outbound WebSocket from our host to Slack — works through
any egress that allows HTTPS — and is the production reality this
install has run on since day one. Per
`feedback_fork_original_carry_across`, fork-original capabilities
(Slack Socket Mode, remote-mcp-servers, the observation pipeline) port
verbatim across upstream rewrites; this fork does not adopt v2's new
abstractions for them.

**What you must NEVER do:**

- **Do not run `setup/install-slack.sh`**. The script fetches
  `origin/channels`, overwrites `src/channels/slack.ts` with the
  upstream webhook shim, and installs `@chat-adapter/slack`. That's a
  hard production regression.
- **Do not run the `/add-slack` skill** for the same reason.
- **Do not "fix" `src/channels/slack.ts` to match upstream** during
  conflict resolution after a `git merge upstream/main`. The fork-port
  is the right code; conflicts go the **fork** way.

**Guard rails in place:**

- `setup/install-slack.sh` has a refusal guard at the top that exits
  non-zero unless `NANOCLAW_FORK_OVERRIDE_INSTALL_SLACK` is set to the
  explicit acknowledgement string. (See the script for the full
  bypass incantation if you ever truly need it.)
- `.claude/skills/add-slack/SKILL.md` carries a DO NOT RUN banner at
  the top with a pointer back to this section.
- `src/channels/slack.ts` line 2 explicitly states "fork-only Socket
  Mode port".

**Authentication:** Socket Mode needs both `SLACK_BOT_TOKEN` and
`SLACK_APP_TOKEN` in `.env`. The bot token (`xoxb-…`) is the normal
Bot User OAuth Token from the Slack app config; the app token
(`xapp-…`) is the Socket Mode connection token — generate it under
*Settings → Basic Information → App-Level Tokens* with the
`connections:write` scope.

**If a fresh checkout looks like the Slack adapter is "missing":** it
is not. Run `pnpm install && pnpm run build` — the adapter source IS
the committed code at `src/channels/slack.ts`.

## OneCLI is mandatory (no fallback)

This fork refuses to start without the OneCLI credential gateway. Both
the host startup gate (`src/onecli-precheck.ts`, called as step 0 of
`main()`) and the container spawn gate
(`src/container-runner.ts:applyOneCLIGateway`) throw fatal on a missing
or unreachable gateway. There is no warn-and-degrade path — agents
must never see raw credentials.

To install + populate OneCLI on this machine, run the `/init-onecli`
skill. Add `ONECLI_URL` + `ONECLI_API_KEY` to `.env` after install;
move any container-facing credentials from `.env` into the vault via
`onecli secrets create --name <Name> --type <type> --value <value>
--host-pattern <host>` and remove the raw values from `.env`. `.env`
keeps only the OneCLI bootstrap pair plus host-process tokens (Slack
bot/app tokens, etc. — these stay on the host process and never enter
containers).

## Observation pipeline lives outside this repo

The observation pipeline (monitor / responder / solver / sanitiser
plugin) is **not** in this repo. Source lives in a sibling repository
on disk (operator-configured); deployed code lands in
`dist/plugins/observation-pipeline/` via the plugin repo's own
`npm run deploy`. Per `feedback_pipeline_external_to_nanoclaw`, the
pipeline stays external to this repo even as a v2 plugin.

The `pipeline/` directory at the project root is an untracked symlink
to the plugin's `specs/` directory — created at install time via
`scripts/ensure-pipeline-symlink.sh`. If it goes missing the sanitiser
config loader silently returns empty defaults and operator messages
leak into observations (`feedback_sanitiser_config_silent`).

## External MCP servers: container-config generator

This fork supports operator-defined MCP servers (`data/mcp-servers.json`
+ optional `data/mcp-exclusions.json`) — both stdio servers mounted
from host paths and remote HTTP servers. The host-side
`container-config generator` (`src/container-config-generator.ts`)
reads these files at startup and on group-creation, then writes the
resolved `mcpServers` map + `additionalMounts` into each agent group's
`groups/<folder>/container.json`. Pipeline-* synthetic groups are
skipped (the pipeline-loader owns those).

Source-of-truth: `data/mcp-servers.json`. Operator hand-edits to the
generator-owned fields of a group's `container.json` are clobbered on
the next regenerate by design — to customise per-group, edit
`data/mcp-exclusions.json` (`{"*": [], "<folder>": []}` — wildcard +
per-folder are additive).

A sidecar `groups/<folder>/.container-generator.json` records which
names the generator currently owns, so removing a server from
`data/mcp-servers.json` cleanly removes it from the group's
`container.json` on next regen without clobbering operator-added
entries that happen to share a key.

The generator auto-adds resolved `hostPath`s to
`~/.config/nanoclaw/mount-allowlist.json` (validated by
`src/modules/mount-security/index.ts`). Allowlist cache is invalidated
on each write so the new entries are visible to subsequent container
spawns within the same process.

## Operator skills install via `install-runtime.sh`

The external plugin repo's `install/install-runtime.sh` covers three
things post-cutover:

1. Renders + applies the runtime monitor / solver prompts to both v2
   sites: `groups/pipeline-{monitor,solver}/CLAUDE.local.md` AND
   `messages_in.content.prompt` in
   `data/v2-sessions/sess-pipeline-*/inbound.db`.
2. Installs **always-install** operator skills (`remote-mcp-servers`,
   `add-reactions`) into `.claude/skills/`.
3. On-demand: `bash install-runtime.sh --install <skill-name>`
   activates one of the packaged-but-not-installed skills
   (`add-image-vision`, `add-pdf-reader`, `add-telegram-swarm`,
   `add-voice-transcription`, `use-local-whisper`).

It refuses to run against a v1-shaped install (no `data/v2.db` or
`data/v2-sessions/`) — points the operator at the K.1.h cutover.

## Pipeline runtime prompts: render + apply

The committed YAML specs in the plugin's `specs/*.yaml` carry only
skeleton `system: |-` fields by policy
(`feedback_no_internal_examples_in_specs`); install-specific
terminology lives in the plugin's `install/surfaces.yaml` and gets
composed into the runtime prompts via `render-prompts.mjs`.
`install-runtime.sh` runs the renderer + applies the result; never
hand-edit the rendered files (`runtime-{monitor,solver}-prompt.txt`).
