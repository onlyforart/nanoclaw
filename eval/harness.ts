/**
 * Eval harness — loads eval sets and runs sanitiser layers against them.
 */

import fs from 'fs';
import path from 'path';

export interface EvalCase {
  id: string;
  description: string;
  tags: string[];
  input: {
    raw_text: string;
    sender_id?: string;
    channel_id?: string;
    thread_ts?: string;
    subtype?: string;
    bot_id?: string;
  };
  expected_layer1: Record<string, unknown>;
  expected_layer2: Record<string, unknown>;
}

/**
 * Load all eval cases from a directory. Each *.json file is one case.
 */
export function loadEvalSet(dir: string): EvalCase[] {
  if (!fs.existsSync(dir)) return [];

  const files = fs
    .readdirSync(dir)
    .filter((f) => f.endsWith('.json'))
    .sort();

  return files.map((f) => {
    const raw = fs.readFileSync(path.join(dir, f), 'utf-8');
    return JSON.parse(raw) as EvalCase;
  });
}
