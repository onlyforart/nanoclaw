# Pipeline E2E test harness

Automated end-to-end tests for the observation pipeline. Injects synthetic
observations with arbitrary sender ids (simulating multiple users) directly
into the `observed_messages` table, publishes `observation.passive` events,
then polls for expected clusters + downstream events.

## How it works

The harness **bypasses the sanitiser** (which would otherwise run an LLM over
the text). Each scenario declares the sanitised classification inline
(`urgency`, `speech_act`, `addressee`, etc.), so we test routing and solver
behaviour without the sanitiser's latency / variability.

Everything else is real: the running daemon's monitor, solver, host-side
mutex, write-action tagger, ack-first flow, team-channel drafts, and
post-write delivery verification all fire.

Because the daemon posts to real channels during this, the scenario target
channel must be one that's acceptable for test traffic.

## Requirements

- nanoclaw daemon running
- The scenario's `source_channel` is a registered passive channel
- Monitor + solver prompts in the DB are the Phase F versions

## Commands

```bash
npm run pipeline-e2e -- run <path/to/scenario.yaml>     # inject + wait + assert
npm run pipeline-e2e -- inject <path/to/scenario.yaml>  # inject only
npm run pipeline-e2e -- cleanup                         # delete all test rows
```

## Scenario format

```yaml
name: <scenario-id and short label>
description: <optional>
source_channel: <channel JID, e.g. slack:C…>
sanitiser_version: '1'
messages:
  - dt_ms: 0                   # relative offset from scenario start
    sender_id: <user id>       # arbitrary string; simulates distinct users
    sender_name: <display>     # optional
    text: <raw message text>
    sanitised:
      urgency: <sanitiser urgency value>
      speech_act: <sanitiser speech-act value>
      addressee: channel|nobody|specific_human|bot
      appears_to_address_bot: false
      contains_imperative: false
      # (additional sanitiser fields pass through)
expected:
  clusters:
    - key: <expected cluster_key slug>
      observation_count: <int>
      status: active|resolved   # optional
  events:
    - type: candidate.escalation|candidate.question|candidate.unhandled|human_review_required
      count: <int>
      payload_contains:          # optional literal-equality checks
        implies_write: true
  timeout_ms: 240000            # optional; default 240000
```

Scenarios for this installation live alongside the pipeline plugin that
deploys the monitor/solver prompts — not in this repo — because they
reference specific channel ids and the in-scope surface slugs configured
on this installation's runtime monitor prompt.

## What's tested vs what isn't

**Tested end-to-end:**

- Cluster formation and `cluster_key` routing
- Mutex rule (exactly one candidate.* per cluster per tick)
- `implies_write` pre-tagging
- `candidate.unhandled` DB-only path (no channel post)
- Escalation dedup by `newest_obs_id`
- Cluster status transitions (active → resolved)
- Per-event solver invocations (via `batch_size: 1`)
- TTL sweep (orphaned events auto-fail after ttl)

**Not tested here** (covered by other suites):

- Sanitiser layer accuracy (labelled-corpus tests)
- Reacji approval flow (requires in-process handler invocation; manual for now)
- Slack API call correctness (integration-tested separately)

## Reacji approval testing

The approval flow requires a reaction on a team-channel draft. Since the
harness can't add reactions as different users via the channel API,
approval testing is manual:

1. Run an injection scenario that produces a draft
2. Watch for the `🟡 PROPOSED REPLY for event <N>…` message in the team channel
3. Manually react 👍 and observe:
   - Draft text lands in source thread
   - 30s later no `pipeline_delivery_failed` event appears

## Cleanup semantics

Test rows are tagged by:

- `observed_messages.source_type = 'e2e_test'`
- `events.source_task_id = 'e2e-test-harness'`
- `events.dedupe_key` prefixed `e2e-obs:` (or `timeout:` for TTL-sweep follow-ons)

`cleanup` deletes rows matching those markers plus any `pipeline_clusters`
composed **entirely** of test observations. Live data is untouched.

## Cost

Each scenario that produces a `candidate.*` event triggers one solver
invocation. Cost depends on the solver's configured model and any tool
calls it makes during investigation.

## Troubleshooting

- **"Cluster not found"** after timeout → monitor not picking up observations.
  Check daemon logs and confirm the monitor task's `next_run` advances.
- **Wrong `cluster_key`** — the monitor chose a different surface slug than
  expected. The runtime overlay defines the canonical slugs; update the
  scenario or the overlay.
- **No draft appears** — solver processed the candidate event but skipped the
  team draft. Check `task_run_logs` for the solver's `result` column.
