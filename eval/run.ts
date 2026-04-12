/**
 * CLI entry point for the eval harness.
 *
 * Usage:
 *   npx tsx eval/run.ts --set eval/sets/adversarial --layer 1
 *   npx tsx eval/run.ts --set eval/sets/golden --layer 2 --model anthropic:haiku
 *   npx tsx eval/run.ts --set eval/sets/golden --full
 */

import fs from 'fs';
import path from 'path';
import { loadEvalSet } from './harness.js';
import { scoreLayer1, scoreLayer2, aggregateScores, type CaseResult } from './scoring.js';

function parseArgs(): { set: string; layer?: string; model?: string; full?: boolean } {
  const args = process.argv.slice(2);
  const result: Record<string, string> = {};
  for (let i = 0; i < args.length; i++) {
    if (args[i].startsWith('--') && i + 1 < args.length) {
      result[args[i].slice(2)] = args[i + 1];
      i++;
    } else if (args[i] === '--full') {
      result.full = 'true';
    }
  }
  return {
    set: result.set || 'eval/sets/adversarial',
    layer: result.layer,
    model: result.model,
    full: result.full === 'true',
  };
}

function main() {
  const opts = parseArgs();
  const cases = loadEvalSet(opts.set);

  if (cases.length === 0) {
    console.log(`No eval cases found in ${opts.set}`);
    process.exit(1);
  }

  console.log(`Loaded ${cases.length} eval cases from ${opts.set}\n`);

  if (opts.layer === '1' || opts.full) {
    console.log('=== Layer 1 (deterministic) ===');
    console.log('Layer 1 eval requires a preprocessor implementation (Phase D).');
    console.log('Skipping until sanitiser Layer 1 is implemented.\n');
  }

  if (opts.layer === '2' || opts.full) {
    console.log('=== Layer 2 (LLM extraction) ===');
    console.log('Layer 2 eval requires an extractor implementation (Phase D).');
    console.log(`Model: ${opts.model || 'not specified'}`);
    console.log('Skipping until sanitiser Layer 2 is implemented.\n');
  }

  // For now, just validate the eval set structure
  console.log('=== Eval Set Validation ===');
  let valid = 0;
  let invalid = 0;
  for (const c of cases) {
    const issues: string[] = [];
    if (!c.id) issues.push('missing id');
    if (!c.input?.raw_text) issues.push('missing input.raw_text');
    if (!c.tags) issues.push('missing tags');

    if (issues.length > 0) {
      console.log(`  INVALID ${c.id || '(no id)'}: ${issues.join(', ')}`);
      invalid++;
    } else {
      valid++;
    }
  }
  console.log(`\n${valid} valid, ${invalid} invalid out of ${cases.length} cases`);

  // Write results
  const resultsDir = path.join(path.dirname(opts.set), '..', 'results');
  fs.mkdirSync(resultsDir, { recursive: true });
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const resultPath = path.join(resultsDir, `${timestamp}.json`);
  fs.writeFileSync(
    resultPath,
    JSON.stringify({ timestamp, set: opts.set, caseCount: cases.length, valid, invalid }, null, 2),
  );
  console.log(`\nResults written to ${resultPath}`);
}

main();
