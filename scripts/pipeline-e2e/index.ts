#!/usr/bin/env tsx
/**
 * Pipeline end-to-end test harness CLI.
 *
 * Usage:
 *   tsx scripts/pipeline-e2e/index.ts run <scenario.yaml>
 *   tsx scripts/pipeline-e2e/index.ts inject <scenario.yaml>
 *   tsx scripts/pipeline-e2e/index.ts assert <scenario.yaml> <observation_ids> <started_at>
 *   tsx scripts/pipeline-e2e/index.ts cleanup
 *
 * The harness expects the live nanoclaw daemon to be running — it
 * writes into the same SQLite file and relies on the scheduler +
 * monitor + solver to process the injected events.
 */

import fs from 'node:fs';
import path from 'node:path';
import { parse as parseYaml } from 'yaml';

import { assertOutcome } from './assert.js';
import { closeDb, cleanupTestRows } from './db.js';
import { injectScenario } from './inject.js';
import type { Scenario } from './types.js';

function loadScenario(filePath: string): Scenario {
  const raw = fs.readFileSync(filePath, 'utf-8');
  const parsed = parseYaml(raw) as Scenario;
  if (!parsed.name || !parsed.source_channel || !parsed.messages) {
    throw new Error(
      `Invalid scenario ${filePath}: missing name/source_channel/messages`,
    );
  }
  return parsed;
}

async function cmdRun(scenarioPath: string): Promise<number> {
  const scenario = loadScenario(scenarioPath);
  console.log(`▶ ${scenario.name}`);
  if (scenario.description) console.log(`  ${scenario.description}`);
  console.log(
    `  channel: ${scenario.source_channel}, messages: ${scenario.messages.length}`,
  );

  const injection = await injectScenario(scenario);
  console.log(
    `  injected ${injection.observation_ids.length} observations: [${injection.observation_ids.join(', ')}]`,
  );
  console.log(
    `  waiting up to ${(scenario.expected.timeout_ms ?? 240_000) / 1000}s for outcomes…`,
  );

  const result = await assertOutcome(scenario, injection);
  const secs = (result.waited_ms / 1000).toFixed(1);

  console.log('');
  console.log(`  clusters formed:`);
  for (const c of result.clusters) {
    console.log(
      `    #${c.id} key=${c.cluster_key} status=${c.status} obs=${c.observation_count}`,
    );
  }
  console.log(`  downstream events:`);
  for (const e of result.events) {
    console.log(
      `    #${e.id} type=${e.type} status=${e.status} created=${e.created_at}`,
    );
  }

  if (result.pass) {
    console.log(`\n  ✅ PASS (${secs}s)`);
    return 0;
  } else {
    console.log(`\n  ❌ FAIL (${secs}s)`);
    for (const f of result.failures) console.log(`     • ${f}`);
    return 1;
  }
}

async function cmdInject(scenarioPath: string): Promise<number> {
  const scenario = loadScenario(scenarioPath);
  console.log(`▶ inject ${scenario.name}`);
  const injection = await injectScenario(scenario);
  console.log(
    JSON.stringify(
      {
        observation_ids: injection.observation_ids,
        started_at: injection.started_at,
        source_channel: injection.source_channel,
      },
      null,
      2,
    ),
  );
  return 0;
}

async function cmdCleanup(): Promise<number> {
  const res = cleanupTestRows();
  console.log(
    `cleaned up: observations=${res.observations}, events=${res.events}, clusters=${res.clusters}`,
  );
  return 0;
}

async function main(): Promise<number> {
  const [cmd, ...args] = process.argv.slice(2);
  switch (cmd) {
    case 'run': {
      if (!args[0]) {
        console.error('usage: run <scenario.yaml>');
        return 2;
      }
      return cmdRun(path.resolve(args[0]));
    }
    case 'inject': {
      if (!args[0]) {
        console.error('usage: inject <scenario.yaml>');
        return 2;
      }
      return cmdInject(path.resolve(args[0]));
    }
    case 'cleanup':
      return cmdCleanup();
    case 'help':
    case undefined:
      console.log(
        [
          'Pipeline E2E test harness',
          '',
          'commands:',
          '  run <scenario.yaml>      Inject + wait + assert + report (exit code = test result)',
          '  inject <scenario.yaml>   Inject observations only; print ids for manual inspection',
          '  cleanup                  Delete all e2e test rows from the DB',
          '',
          'scenarios live in scripts/pipeline-e2e/scenarios/*.yaml',
        ].join('\n'),
      );
      return 0;
    default:
      console.error(`unknown command: ${cmd}`);
      return 2;
  }
}

main()
  .then((code) => {
    closeDb();
    process.exit(code);
  })
  .catch((err) => {
    console.error(err);
    closeDb();
    process.exit(1);
  });
