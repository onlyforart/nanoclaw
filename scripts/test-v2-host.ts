/**
 * Real end-to-end test of v2.
 *
 * Phase 1 (default): pipeline plugin dry-run — build pipeline, deploy
 * to worktree dist/plugins/observation-pipeline/, discover, register,
 * onStartup, then exercise a passive observation through fast-path →
 * trivial-answerer → channel.deliver(). Mock channel adapter captures
 * the delivery; stub MCP server (scripts/test-mcp-stub.mjs) returns a
 * deterministic response so the trivial-answerer can complete.
 *
 * Phase 2 (opt-in): container roundtrip — host router → Docker
 * container → agent-runner → delivery. Needs Docker + Claude. Run
 * with `--container` to exercise.
 *
 *   pnpm exec tsx scripts/test-v2-host.ts                  # pipeline only
 *   pnpm exec tsx scripts/test-v2-host.ts --container      # + container
 *   pnpm exec tsx scripts/test-v2-host.ts --container-only # skip pipeline
 */
import Database from 'better-sqlite3';
import { execSync } from 'node:child_process';
import fs from 'fs';
import path from 'path';

const args = process.argv.slice(2);
const RUN_PIPELINE = !args.includes('--container-only');
const RUN_CONTAINER = args.includes('--container') || args.includes('--container-only');

const TEST_DIR = '/tmp/nanoclaw-v2-e2e';
if (fs.existsSync(TEST_DIR)) fs.rmSync(TEST_DIR, { recursive: true });
fs.mkdirSync(TEST_DIR, { recursive: true });

// --- Step 1: Init central DB ---
console.log('\n=== Step 1: Init central DB ===');

import { initDb } from '../src/db/connection.js';
import { runMigrations } from '../src/db/migrations/index.js';
import { createAgentGroup } from '../src/db/agent-groups.js';
import { createMessagingGroup, createMessagingGroupAgent } from '../src/db/messaging-groups.js';

const centralDb = initDb(path.join(TEST_DIR, 'v2.db'));
runMigrations(centralDb);
console.log('✓ Central DB initialized');

// =============================================================
//   Phase 1 — Pipeline plugin dry-run
// =============================================================

if (RUN_PIPELINE) {
  await runPipelineDryRun();
}

async function runPipelineDryRun() {
  // --- Step P1: Build pipeline plugin ---
  console.log('\n=== [Pipeline] Step P1: Build pipeline plugin ===');
  const WORKTREE_ROOT = process.cwd();
  const PIPELINE_ROOT = process.env.NANOCLAW_PIPELINE_ROOT;
  if (!PIPELINE_ROOT) {
    throw new Error(
      'NANOCLAW_PIPELINE_ROOT env var not set — point it at the plugin repo root before running test-v2-host.',
    );
  }
  if (!fs.existsSync(PIPELINE_ROOT)) {
    throw new Error(`Pipeline source not found at ${PIPELINE_ROOT}`);
  }
  execSync('npm run build', { cwd: PIPELINE_ROOT, stdio: 'inherit' });
  console.log('✓ Pipeline built');

  // --- Step P2: Deploy plugin to worktree dist/plugins/ ---
  console.log('\n=== [Pipeline] Step P2: Deploy plugin to worktree dist ===');
  const PLUGIN_TARGET = path.join(WORKTREE_ROOT, 'dist/plugins/observation-pipeline');
  fs.rmSync(PLUGIN_TARGET, { recursive: true, force: true });
  fs.mkdirSync(path.dirname(PLUGIN_TARGET), { recursive: true });
  execSync(`cp -r ${path.join(PIPELINE_ROOT, 'build')}/. ${PLUGIN_TARGET}/`);
  console.log(`✓ Plugin deployed to ${PLUGIN_TARGET}`);

  // --- Step P3: Write data/mcp-servers.json pointing at the stub ---
  // Reads the committed fixture template (scripts/test-mcp-servers.json),
  // substitutes __WORKTREE_ROOT__ with the actual path, and writes to
  // data/mcp-servers.json for the test run. Any pre-existing
  // data/mcp-servers.json is backed up first so the operator's real
  // config survives test runs.
  console.log('\n=== [Pipeline] Step P3: Configure stub MCP server ===');
  const dataDir = path.join(WORKTREE_ROOT, 'data');
  fs.mkdirSync(dataDir, { recursive: true });
  const FIXTURE_PATH = path.join(WORKTREE_ROOT, 'scripts/test-mcp-servers.json');
  const fixtureRaw = fs.readFileSync(FIXTURE_PATH, 'utf-8');
  const mcpServersJson = fixtureRaw.replace(/__WORKTREE_ROOT__/g, WORKTREE_ROOT);
  const mcpServersPath = path.join(dataDir, 'mcp-servers.json');
  const backupPath = `${mcpServersPath}.backup-step8.5`;
  if (fs.existsSync(mcpServersPath) && !fs.existsSync(backupPath)) {
    fs.copyFileSync(mcpServersPath, backupPath);
  }
  fs.writeFileSync(mcpServersPath, mcpServersJson);
  console.log(`✓ ${mcpServersPath} written from ${FIXTURE_PATH}`);

  // --- Step P4: Register + activate mock channel adapter ---
  // Pipeline's trivial-answerer reply path resolves the adapter via
  // `host.getChannelAdapter('slack')`, which reads the *active* map
  // (channel-registry.ts). Just calling registerChannelAdapter only
  // populates the registry — initChannelAdapters() must run to
  // instantiate + activate. We supply a minimal ChannelSetup whose
  // callbacks are no-ops (test doesn't exercise inbound).
  console.log('\n=== [Pipeline] Step P4: Register + activate mock slack channel adapter ===');
  const captured: Array<{
    platformId: string;
    threadId: string | null;
    message: { kind: string; content: unknown };
  }> = [];
  const { registerChannelAdapter, initChannelAdapters } = await import('../src/channels/channel-registry.js');
  registerChannelAdapter('slack', {
    factory: () => ({
      name: 'mock-slack',
      channelType: 'slack',
      supportsThreads: true,
      setup: async () => undefined,
      teardown: async () => undefined,
      isConnected: () => true,
      deliver: async (platformId, threadId, message) => {
        captured.push({ platformId, threadId, message });
        return `mock-msg-${captured.length}`;
      },
    }),
    containerConfig: { env: {}, mcpServers: {} },
  });
  await initChannelAdapters(() => ({
    onInbound: () => undefined,
    onInboundEvent: () => undefined,
    onMetadata: () => undefined,
    onAction: () => undefined,
  }));
  console.log('✓ Mock slack adapter active');

  // --- Step P5: Set up fixtures (agent group, messaging group, wiring, passive subscription) ---
  console.log('\n=== [Pipeline] Step P5: Pipeline fixtures ===');
  createAgentGroup({
    id: 'ag-pipeline',
    name: 'Pipeline Test',
    folder: 'pipeline-test',
    agent_provider: 'claude',
    created_at: new Date().toISOString(),
  });
  createMessagingGroup({
    id: 'mg-pipeline',
    channel_type: 'slack',
    platform_id: 'C_PIPETEST',
    name: 'Pipeline Test Channel',
    is_group: 1,
    unknown_sender_policy: 'public',
    created_at: new Date().toISOString(),
  });
  createMessagingGroupAgent({
    id: 'mga-pipeline',
    messaging_group_id: 'mg-pipeline',
    agent_group_id: 'ag-pipeline',
    engage_mode: 'pattern',
    engage_pattern: '.',
    sender_scope: 'all',
    ignored_message_policy: 'drop',
    session_mode: 'shared',
    priority: 0,
    created_at: new Date().toISOString(),
  });
  console.log('✓ Pipeline fixtures created');

  // --- Step P6: Discover + register + onStartup pipeline plugin ---
  console.log('\n=== [Pipeline] Step P6: Load pipeline plugin ===');
  const { discoverPlugins, runPluginsRegister, runPluginsStartup, buildHostApi } = await import(
    '../src/plugin-loader.js'
  );
  const PLUGINS_DIR = path.join(WORKTREE_ROOT, 'dist/plugins');
  const plugins = await discoverPlugins(PLUGINS_DIR);
  console.log(`Found ${plugins.length} plugin(s):`, plugins.map((p) => p.manifest.name));
  if (plugins.length === 0) {
    throw new Error('No plugins discovered — deploy step failed?');
  }
  const host = buildHostApi(centralDb);
  runPluginsRegister(plugins, host);
  // Re-run migrations so plugin migrations land alongside core's.
  runMigrations(centralDb);
  await runPluginsStartup(plugins);
  console.log(`✓ ${plugins.length} plugin(s) registered + onStartup complete`);

  // Plugin is loaded — now seed pipeline-side fixtures via its public DB.
  // Pipeline's getPassiveSubscriptions / addPassiveSubscription live in
  // the deployed plugin's compiled JS; import that directly.
  const pipelineDb = await import(path.join(PLUGIN_TARGET, 'db.js'));
  pipelineDb.addPassiveSubscription('slack', 'C_PIPETEST');
  console.log('✓ Passive subscription seeded: slack:C_PIPETEST');

  // Tell the trivial-answerer where to find surfaces.yaml.
  process.env.PIPELINE_SURFACES_YAML = path.join(
    WORKTREE_ROOT,
    'scripts/test-pipeline-surfaces.yaml',
  );

  // --- Step P7: Inject passive observation + drive fast-path ---
  console.log('\n=== [Pipeline] Step P7: Inject observation + fast-path ===');
  const { maybeFastPathRoute } = await import(path.join(PLUGIN_TARGET, 'fast-path.js'));
  const { default: yaml } = await import('yaml');
  const surfacesText = fs.readFileSync(process.env.PIPELINE_SURFACES_YAML, 'utf-8');
  const surfaces = yaml.parse(surfacesText);

  const obsId = pipelineDb.insertObservedMessage({
    source_type: 'passive_channel',
    source_chat_jid: 'C_PIPETEST',
    source_message_id: 'msg-1',
    raw_text: 'test status',
    thread_id: null,
  });
  console.log(`✓ Observation inserted (id=${obsId})`);

  const fpResult = maybeFastPathRoute(
    {
      observation_id: obsId,
      // Bare platform_id (matches host-pipeline-executor's
      // `channel_id: sub.platform_id`), NOT the v1-style
      // 'slack:CMAIN' prefix. Trivial-answerer queries
      // pipeline_passive_subscriptions.platform_id with this
      // string — must match what addPassiveSubscription stored.
      source_channel: 'C_PIPETEST',
      source_message_id: 'msg-1',
      raw_text: 'test status',
    },
    surfaces,
  );
  console.log(`✓ Fast-path: fired=${fpResult.fired} cluster_key=${fpResult.cluster_key ?? 'n/a'}`);
  if (!fpResult.fired) {
    throw new Error('Fast-path did not fire — surfaces fixture mismatch?');
  }

  // Verify candidate.question landed in pipeline_events.
  const evRow = centralDb
    .prepare(`SELECT type, status FROM pipeline_events WHERE type = 'candidate.question' LIMIT 1`)
    .get() as { type: string; status: string } | undefined;
  if (!evRow) throw new Error('candidate.question event missing from pipeline_events');
  console.log(`✓ pipeline_events row: type=${evRow.type} status=${evRow.status}`);

  // --- Step P8: Run trivial-answerer sweep ---
  // We call `runTrivialAnswerSweep(host, …)` directly rather than the
  // scheduler-driven `runDuePipelineTasks()`. Same SUT — both invoke
  // the trivial-answerer loop with identical deps. The scheduler
  // wrapper would otherwise require seeding a `pipeline_scheduled_tasks`
  // row (created in production by the pipeline-loader from
  // sanitiser-config.yaml, which we don't ship in step 8.5).
  console.log('\n=== [Pipeline] Step P8: Run trivial-answerer sweep ===');
  const { runTrivialAnswerSweep } = await import(path.join(PLUGIN_TARGET, 'trivial-answer-task.js'));
  const sweepResult = await runTrivialAnswerSweep(host, { limit: 10 });
  console.log(
    `✓ trivial-answerer sweep: considered=${sweepResult.considered} answered=${sweepResult.answered} released=${sweepResult.released} skipped=${sweepResult.skipped}`,
  );
  if (Object.keys(sweepResult.failure_breakdown).length > 0) {
    console.log('  failure_breakdown:', sweepResult.failure_breakdown);
  }

  // --- Step P9: Verify channel.deliver() was called ---
  console.log('\n=== [Pipeline] Step P9: Verify outbound delivery ===');
  if (captured.length === 0) {
    console.log('✗ No deliveries captured');
    const evAfter = centralDb
      .prepare(
        `SELECT type, status, result_note, claimed_by FROM pipeline_events
         WHERE type = 'candidate.question' LIMIT 1`,
      )
      .get();
    console.log('candidate.question state:', evAfter);
    throw new Error('Pipeline obs-flow did not reach channel.deliver');
  }
  for (const c of captured) {
    console.log(
      `✓ delivered to ${c.platformId} (thread=${c.threadId ?? 'n/a'}): ${
        typeof c.message.content === 'string' ? c.message.content : JSON.stringify(c.message.content)
      }`,
    );
  }
  console.log('✓ Pipeline obs-flow OK — fast-path → trivial-answerer → channel.deliver');

  // Restore mcp-servers.json backup if present.
  if (fs.existsSync(backupPath)) {
    fs.copyFileSync(backupPath, mcpServersPath);
    fs.unlinkSync(backupPath);
  } else {
    fs.unlinkSync(mcpServersPath);
  }
}

// =============================================================
//   Phase 2 — Container roundtrip (opt-in)
// =============================================================

if (RUN_CONTAINER) {
  await runContainerRoundtrip();
} else {
  console.log('\n(skipping container roundtrip; pass --container to enable)');
}

async function runContainerRoundtrip() {
  // Create groups dir for agent folder mount
  const groupsDir = path.resolve(process.cwd(), 'groups');
  const testGroupDir = path.join(groupsDir, 'test-agent-e2e');
  fs.mkdirSync(testGroupDir, { recursive: true });
  fs.writeFileSync(path.join(testGroupDir, 'CLAUDE.md'), '# Test Agent\nYou are a test agent. Be brief.\n');

  createAgentGroup({
    id: 'ag-e2e',
    name: 'E2E Test Agent',
    folder: 'test-agent-e2e',
    agent_provider: 'claude',
    created_at: new Date().toISOString(),
  });

  createMessagingGroup({
    id: 'mg-e2e',
    channel_type: 'test',
    platform_id: 'e2e-channel',
    name: 'E2E Test Channel',
    is_group: 0,
    unknown_sender_policy: 'public',
    created_at: new Date().toISOString(),
  });

  createMessagingGroupAgent({
    id: 'mga-e2e',
    messaging_group_id: 'mg-e2e',
    agent_group_id: 'ag-e2e',
    engage_mode: 'pattern',
    engage_pattern: '.',
    sender_scope: 'all',
    ignored_message_policy: 'drop',
    session_mode: 'shared',
    priority: 0,
    created_at: new Date().toISOString(),
  });

  // --- Step C2: Route inbound message (spawns container) ---
  console.log('\n=== [Container] Step C2: Route inbound message ===');

  const { routeInbound } = await import('../src/router.js');
  const { findSession } = await import('../src/db/sessions.js');
  const { inboundDbPath, outboundDbPath } = await import('../src/session-manager.js');

  await routeInbound({
    channelType: 'test',
    platformId: 'e2e-channel',
    threadId: null,
    message: {
      id: 'msg-e2e-1',
      kind: 'chat',
      content: JSON.stringify({
        sender: 'Gavriel',
        text: 'Say "E2E works!" and nothing else. Do not use any tools.',
      }),
      timestamp: new Date().toISOString(),
    },
  });

  const session = findSession('mg-e2e', null);
  if (!session) {
    console.log('✗ No session created!');
    process.exit(1);
  }
  console.log(`✓ Session: ${session.id}`);
  console.log(`✓ Container status: ${session.container_status}`);

  const inDbPath = inboundDbPath('ag-e2e', session.id);
  const outDbPath = outboundDbPath('ag-e2e', session.id);
  console.log(`✓ Inbound DB: ${inDbPath}`);
  console.log(`✓ Outbound DB: ${outDbPath}`);

  // --- Step C3: Wait for response ---
  console.log('\n=== [Container] Step C3: Waiting for Claude response... ===');

  const startTime = Date.now();
  const TIMEOUT_MS = 120_000;

  const checkForResponse = (): boolean => {
    try {
      const db = new Database(outDbPath, { readonly: true });
      const out = db.prepare('SELECT * FROM messages_out').all() as Array<Record<string, unknown>>;
      db.close();
      return out.length > 0;
    } catch {
      return false;
    }
  };

  await new Promise<void>((resolve) => {
    const poll = () => {
      if (checkForResponse()) {
        resolve();
        return;
      }
      if (Date.now() - startTime > TIMEOUT_MS) {
        console.log(`\n✗ Timed out after ${TIMEOUT_MS / 1000}s`);
        printState(inDbPath, outDbPath);
        process.exit(1);
      }
      const elapsed = Math.floor((Date.now() - startTime) / 1000);
      if (elapsed > 0 && elapsed % 10 === 0) {
        process.stdout.write(`  ${elapsed}s...`);
      }
      setTimeout(poll, 1000);
    };
    poll();
  });

  // --- Step C4: Print results ---
  console.log('\n\n=== [Container] Results ===');
  printState(inDbPath, outDbPath);

  // Clean up test group dir
  fs.rmSync(testGroupDir, { recursive: true, force: true });
}

console.log('\n=== ALL PHASES OK ===');
process.exit(0);

function printState(inDbPath: string, outDbPath: string) {
  try {
    const inDb = new Database(inDbPath, { readonly: true });
    const inRows = inDb.prepare('SELECT * FROM messages_in').all() as Array<Record<string, unknown>>;
    inDb.close();

    console.log('\nmessages_in (inbound.db):');
    for (const r of inRows) {
      console.log(`  [${r.id}] status=${r.status} kind=${r.kind}`);
    }
  } catch (err) {
    console.log(`  (could not read inbound DB: ${err})`);
  }

  try {
    const outDb = new Database(outDbPath, { readonly: true });
    const outRows = outDb.prepare('SELECT * FROM messages_out').all() as Array<Record<string, unknown>>;
    const ackRows = outDb.prepare('SELECT * FROM processing_ack').all() as Array<Record<string, unknown>>;
    outDb.close();

    console.log('\nmessages_out (outbound.db):');
    for (const r of outRows) {
      const content = JSON.parse(r.content as string);
      console.log(`  [${r.id}] kind=${r.kind}`);
      console.log(`  → ${content.text}`);
    }

    console.log('\nprocessing_ack (outbound.db):');
    for (const r of ackRows) {
      console.log(`  [${r.message_id}] status=${r.status} changed=${r.status_changed}`);
    }
  } catch (err) {
    console.log(`  (could not read outbound DB: ${err})`);
  }
}
