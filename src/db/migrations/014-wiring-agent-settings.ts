/**
 * K.1.f step 9.0 — per-wiring agent settings.
 *
 * Adds six columns to `messaging_group_agents` matching the fork-original
 * v1 capability that lived on `registered_groups`:
 *
 *   is_main          INTEGER NOT NULL DEFAULT 0  — per-wiring "primary"
 *                                                  marker; at most one
 *                                                  is_main=1 per
 *                                                  agent_group_id
 *                                                  (enforced by partial
 *                                                  unique index below)
 *   model            TEXT     nullable           — engine override
 *   temperature      REAL     nullable
 *   max_tool_rounds  INTEGER  nullable
 *   timeout_ms       INTEGER  nullable
 *   show_thinking    INTEGER  nullable           — 0 / 1 boolean
 *
 * Resolution semantics: NULL fields fall back to
 * `data/backend-defaults.json[agent_group.agent_provider]` at session
 * spawn time (Commit 2 of step 9.0 wires this in container-runner).
 *
 * Why per-wiring (Q-sub-fork b — verbatim port): v1 stored these on
 * `registered_groups`, which mapped 1:1 to a (channel, agent) wiring.
 * v2's `messaging_group_agents` is the same conceptual entity. Per
 * `feedback_fork_original_carry_across`, fork-original capabilities
 * port verbatim — same column location, same semantics.
 *
 * Partial unique index: enforces the v1 invariant "an agent group has
 * exactly one main channel" race-safely at the DB layer rather than in
 * the helper. SQLite supports partial unique indexes natively; the
 * WHERE clause means is_main=0 rows are unconstrained and only the
 * is_main=1 row per agent_group_id is unique.
 */
import type Database from 'better-sqlite3';
import type { Migration } from './index.js';

export const migration014: Migration = {
  version: 14,
  name: 'wiring-agent-settings',
  up(db: Database.Database) {
    db.exec(`ALTER TABLE messaging_group_agents ADD COLUMN is_main INTEGER NOT NULL DEFAULT 0`);
    db.exec(`ALTER TABLE messaging_group_agents ADD COLUMN model TEXT`);
    db.exec(`ALTER TABLE messaging_group_agents ADD COLUMN temperature REAL`);
    db.exec(`ALTER TABLE messaging_group_agents ADD COLUMN max_tool_rounds INTEGER`);
    db.exec(`ALTER TABLE messaging_group_agents ADD COLUMN timeout_ms INTEGER`);
    db.exec(`ALTER TABLE messaging_group_agents ADD COLUMN show_thinking INTEGER`);
    db.exec(
      `CREATE UNIQUE INDEX uniq_messaging_group_agents_main
         ON messaging_group_agents (agent_group_id)
        WHERE is_main = 1`,
    );
  },
};
