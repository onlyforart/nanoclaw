# Observation Pipeline — Phase D Implementation Plan

## Context

Phase D builds the sanitiser — the security-critical component that transforms raw human messages into structured observations safe for LLM consumption. It is a three-layer pipeline: deterministic pre-processing (code), LLM semantic extraction (constrained JSON, no tools), and deterministic post-processing (code). The LLM never sees raw Slack payloads and never has tool access.

**Depends on:**
- [Phase A](OBSERVATION-PIPELINE-PHASE-A.md) — events table, observed_messages table, passive mode, read_chat_messages, allowed_tools/send_targets, pipeline YAML loader, host_pipeline context_mode
- [Phase C](OBSERVATION-PIPELINE-PHASE-C.md) — eval harness, adversarial test set, field catalog

**Blocks:** [Phase E](OBSERVATION-PIPELINE-PHASE-E.md) (monitor/solver/responder consume sanitiser output).

## Items

1. Layer 1: deterministic pre-processor
2. Layer 2: LLM semantic extractor
3. Layer 3: deterministic post-processor
4. `re_extract_observation` MCP tool + field catalog wiring
5. Sanitiser task wired to source channels + host-side execution

---

## PR 1: Layer 1 — deterministic pre-processor (Item 1)

Zero injection surface. All extraction is regex, structural parsing, and metadata reading. Unit-tested.

### Implementation

**src/sanitiser/layer1.ts** — new file:

```ts
interface Layer1Input {
  raw_text: string;
  sender_id: string;
  channel_id: string;
  thread_ts?: string;
  subtype?: string;         // Slack message subtype
  bot_id?: string;
  timestamp: string;
}

interface Layer1Output {
  // Pass-through metadata
  sender_id: string;
  channel_id: string;
  thread_ts: string | null;
  timestamp: string;

  // Extracted fields
  referenced_tickets: Array<{ id: string; system: string }>;  // {id: 'INC12345', system: 'servicenow'}
  inc_present: boolean;
  code_blocks: Array<{ kind: string; content: string }>;       // kind: json|log|stack_trace|http_request|fix_message|other
  links: Array<{ url: string; is_internal: boolean }>;
  mentions: Array<{ user_id: string; is_bot_address: boolean }>;
  is_channel_join: boolean;
  is_bot_message: boolean;
  message_length: number;

  // Pre-processed text for Layer 2
  processed_text: string;    // truncated, PII-redacted, code blocks replaced with placeholders
  filtered: boolean;         // true if message should be skipped entirely (channel_join, etc.)
  filter_reason?: string;
}
```

Key functions:
- `preprocessMessage(input: Layer1Input, config: Layer1Config): Layer1Output`
- `extractTicketReferences(text: string, patterns: TicketPattern[]): Array<{ id: string; system: string }>` — configurable regex patterns (not hardcoded). Default patterns from spec: `INC\d+`, `CHG\d+`, `RITM\d+`, plus configurable JIRA project patterns, RT URL patterns. New patterns added via config, not code.
- `extractCodeBlocks(text: string): Array<{ kind: string; content: string }>` — markdown fence detection + `classifyCodeBlock()` heuristic
- `classifyCodeBlock(content: string): string` — json, log, stack_trace, http_request, fix_message, other
- `extractLinks(text: string, internalPatterns: RegExp[]): Array<{ url: string; is_internal: boolean }>`
- `extractMentions(text: string, botUserIds: string[]): Array<{ user_id: string; is_bot_address: boolean }>` — `<@U...>` pattern
- `redactPII(text: string): string` — emails, phone numbers, known internal URL patterns. Replaces with `[REDACTED_EMAIL]`, `[REDACTED_PHONE]`, `[REDACTED_URL]`.
- `truncateForLLM(text: string, maxChars: number): string` — truncate to configured max (default: 2000 chars), add `[TRUNCATED]` marker

**src/sanitiser/layer1-config.ts** — new file:
- `Layer1Config` interface: ticket patterns, internal URL patterns, bot user IDs, max text length, PII patterns
- `loadLayer1Config()` — reads from `pipeline/sanitiser-config.yaml` or defaults

**pipeline/sanitiser-config.yaml** — new file:
```yaml
ticket_patterns:
  - pattern: 'INC\d+'
    system: servicenow
  - pattern: 'CHG\d+'
    system: servicenow
  - pattern: 'RITM\d+'
    system: servicenow
  # Add JIRA project patterns per installation:
  # - pattern: 'PROJ-\d+'
  #   system: jira
internal_url_patterns:
  - '\.internal\.'
  - '\.corp\.'
bot_user_ids: []            # populated per-installation
max_text_length: 2000
pii_patterns:
  email: '[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}'
  phone: '\+?\d[\d\s\-()]{7,}'
```

### Tests (TDD — tests first)

**src/sanitiser/layer1.test.ts** — new file:
- Ticket extraction: INC, CHG, RITM, configurable JIRA patterns, mixed, none, multiple in one message
- Code block detection: fenced, unfenced, nested, multiple, classification heuristic
- Link extraction: internal vs external, multiple, malformed
- Mention extraction: single, multiple, bot address detection
- PII redaction: emails, phone numbers, URLs, no false positives on ticket IDs
- Truncation: under limit (no change), over limit (truncated + marker), exact limit
- Channel join filtering: subtype='channel_join' → filtered=true
- Bot message detection: bot_id present, subtype='bot_message'
- Full preprocessMessage: end-to-end with representative inputs
- Adversarial: injection attempts in code blocks, mentions, ticket-like patterns

---

## PR 2: Layer 2 — LLM semantic extractor (Item 2)

The narrowest LLM usage in the system: constrained JSON output, no tools, pre-processed input only.

### Implementation

**src/sanitiser/layer2.ts** — new file:

```ts
interface Layer2Input {
  processed_text: string;              // from Layer 1
  deterministic_fields: Partial<Layer1Output>;  // context for the LLM
}

interface Layer2Output {
  fact_summary: string;                // ≤200 chars
  urgency: string;                     // fyi|question|issue|incident|other
  speech_act: string;                  // fresh_report|status_update|still_broken|...
  reporter_role_hint: string;          // original_reporter|forwarder|diagnostician|...
  appears_to_address_bot: boolean;
  contains_imperative: boolean;
  sentiment: string;                   // neutral|frustrated|urgent|confused|other
  action_requested: string | null;     // ≤150 chars, third-person
  resolution_owner_hint: string;       // this_team|other_internal_team|external_vendor|customer|unclear
}
```

Key functions:
- `extractSemanticFields(input: Layer2Input, options: Layer2Options): Promise<Layer2Output>` — calls LLM via Anthropic Messages API (directly, not via container). Returns parsed JSON.
- `buildExtractionPrompt(input: Layer2Input): MessageParam[]` — constructs the narrow prompt:
  - System: "You are a structured data extractor..." (from sanitiser YAML spec)
  - User: pre-processed text + deterministic fields as context + output schema + few-shot examples
  - Requests JSON output with specific field names and types
- `parseAndValidateResponse(raw: string): Layer2Output | null` — parse JSON, validate field types. Returns null on invalid output (Layer 3 handles quarantine).

**src/sanitiser/layer2-prompt.ts** — new file:
- System prompt template
- Few-shot examples (from eval set — imperative inputs → descriptive action_requested)
- Output schema definition (for constrained JSON / tool_use extraction)

**LLM invocation strategy:**
- Use Anthropic Messages API directly from host-side code (not container)
- Model: `anthropic:haiku` or `ollama:qwen3` (configurable in sanitiser YAML spec)
- Use tool_use with a single tool whose schema matches Layer2Output — this gives structured JSON output without constrained decoding support. The "tool" is never executed; we just parse the tool_use input.
- Alternatively, if the model supports JSON mode, use that. The tool_use approach works universally.

**API client for host-side LLM calls:**

**src/sanitiser/llm-client.ts** — new file:
- `callExtractionLLM(systemPrompt, userMessage, schema, options)` — makes HTTP POST to `http://127.0.0.1:{CREDENTIAL_PROXY_PORT}/v1/messages` with placeholder credentials. The credential proxy injects the real API key. This maintains the invariant that **no code outside the credential proxy ever reads API keys from `.env`**.
- Returns raw JSON string. Layer 2 parses; Layer 3 validates.
- Token tracking: returns `{ response, inputTokens, outputTokens, cacheReadInputTokens, cacheCreationInputTokens, costUSD }` matching the existing `ContainerOutput.usage` shape so the host-pipeline executor can log to `task_run_logs` via the same `logTaskRun()` path used by container-based tasks.

### Tests

**src/sanitiser/layer2.test.ts** — new file:
- Prompt construction: verify structure, few-shot examples included, schema present
- Response parsing: valid JSON, missing fields, wrong types, extra fields
- Integration with eval harness: `npx tsx eval/run.ts --set eval/sets/adversarial --layer 2 --model anthropic:haiku`

The eval harness (Phase C) is the primary testing tool for Layer 2. Unit tests cover prompt construction and response parsing; the eval harness covers extraction quality.

---

## PR 3: Layer 3 — deterministic post-processor (Item 3)

Enforcement layer. Even if the LLM is fully compromised, Layer 3 caps, validates, and quarantines.

### Implementation

**src/sanitiser/layer3.ts** — new file:

```ts
interface Layer3Input {
  layer1: Layer1Output;
  layer2Raw: string;                    // raw LLM response (before parsing)
}

interface Layer3Output {
  sanitised_json: object | null;        // combined Layer 1 + Layer 2, validated
  flags: string[];                      // e.g. ['schema_invalid', 'review_required']
  quarantined: boolean;
}
```

Key functions:
- `postProcess(input: Layer3Input, schema: SanitiserSchema): Layer3Output`
- `validateSchema(parsed: unknown, schema: SanitiserSchema): ValidationResult` — JSON schema validation. Missing required fields or wrong types → quarantine.
- `enforceFieldCaps(obj: Record<string, unknown>, caps: Record<string, number>): Record<string, unknown>` — hard truncation on all string fields. `fact_summary` ≤ 200, `action_requested` ≤ 150, etc.
- `validateEnums(obj: Record<string, unknown>, enums: Record<string, string[]>): { valid: boolean; unknownValues: Array<{ field: string; value: string }> }` — known values pass through; unknown values allowed (open enums) but logged for review.
- `quarantine(reason: string): Layer3Output` — returns `{ sanitised_json: null, flags: ['schema_invalid', reason], quarantined: true }`

**Nonce wrapping** (delivery-time, not storage-time):

**src/sanitiser/nonce.ts** — new file:
- `wrapWithNonce(payload: string): { wrapped: string; nonce: string }` — generates random nonce, wraps payload:
  ```
  ===OBSERVATION-{nonce}===
  {payload}
  ===END-OBSERVATION-{nonce}===
  ```
- `stripNoncePatterns(text: string): string` — removes any occurrence of `===OBSERVATION-...===` or `===END-OBSERVATION-...===` from input before wrapping (prevents spoofing)
- Applied in `src/ipc.ts` at `consume_events` delivery time (Phase A's event handlers), not at storage time. The `sanitised_json` in `observed_messages` is stored clean.

**src/sanitiser/schema.ts** — new file:
- `SanitiserSchema` definition: field names, types, caps, enum values
- `loadSanitiserSchema()` — loads from `pipeline/sanitiser-schema.yaml`
- Version tracked: `schema_version` stored alongside each extraction

**pipeline/sanitiser-schema.yaml** — new file:
```yaml
version: 1
fields:
  fact_summary:
    type: string
    required: true
    max_length: 200
  urgency:
    type: enum
    required: true
    values: [fyi, question, issue, incident, other]
    open: true
  speech_act:
    type: enum
    required: true
    values: [fresh_report, status_update, still_broken, fix_announcement, self_resolution, diagnosis, downstream_notification, change_attribution_question, architectural_request, data_request, banter, other]
    open: true
  reporter_role_hint:
    type: enum
    required: true
    values: [original_reporter, forwarder, diagnostician, responder, fix_committer, access_broker, other]
    open: true
  appears_to_address_bot:
    type: boolean
    required: true
  contains_imperative:
    type: boolean
    required: true
  sentiment:
    type: enum
    required: true
    values: [neutral, frustrated, urgent, confused, other]
    open: true
  action_requested:
    type: string
    required: false
    nullable: true
    max_length: 150
  resolution_owner_hint:
    type: enum
    required: true
    values: [this_team, other_internal_team, external_vendor, customer, unclear]
    open: true
```

### Tests (TDD)

**src/sanitiser/layer3.test.ts** — new file:
- Schema validation: valid JSON passes, missing required fields → quarantine, wrong types → quarantine, extra fields stripped
- Field caps: strings over limit truncated, strings under limit unchanged
- Enum validation: known values pass, unknown values pass but flagged, non-string values → quarantine
- Quarantine: invalid input produces correct flags and null sanitised_json
- Nonce wrapping: wraps correctly, strips existing nonce patterns from input, nonce is random per call

**src/sanitiser/nonce.test.ts** — new file:
- Wrap/unwrap round-trip
- Strip spoofed delimiters
- Random nonce uniqueness

---

## PR 4: re_extract_observation MCP tool + field catalog wiring (Item 4)

### Implementation

**container/agent-runner/src/ipc-mcp-stdio.ts** — new `server.tool()`:
```ts
re_extract_observation(
  observation_id: number,
  request_fields: string[]   // names from field catalog
) -> { ok: true, fields: {...} } | { ok: false, error: string }
```
- Writes IPC file with `type: 'reextract_observation'`, waits for result
- Validation: only accepts field names that exist in the loaded catalog (host validates, not container)

**src/ipc.ts** — new handler in `processTaskIpc()`:
- `case 'reextract_observation':` →
  1. Load observation from `observed_messages` by ID
  2. Load field catalog entries for requested field names
  3. For each field: check cache (`reextraction_cache` table) for `(observation_id, field_name, sanitiser_version)`. If cached, return cached result.
  4. If not cached: call LLM with the field's `prompt_fragment` and the observation's raw_text (pre-processed by Layer 1). Use same LLM client as Layer 2.
  5. Validate response against field's `output_type` and `max_length`
  6. Cache result
  7. Return combined fields

**src/db.ts** — new table:
```sql
CREATE TABLE IF NOT EXISTS reextraction_cache (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  observation_id INTEGER NOT NULL,
  field_name TEXT NOT NULL,
  sanitiser_version TEXT NOT NULL,
  result_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE(observation_id, field_name, sanitiser_version)
);
```

**container/agent-runner/src/index.ts** — add `'re_extract_observation'` to nanoclaw tool arrays (both paths, both scheduled and non-scheduled)

### Tests
- `src/ipc.test.ts` or new file: re-extraction with valid field names, invalid field names rejected, cache hit, cache miss
- `src/db.test.ts`: cache insert, cache lookup, cache miss

---

## PR 5: Sanitiser task + host-side pipeline execution (Item 5)

This is where everything comes together. The sanitiser runs as a host-side pipeline task, orchestrating all three layers.

### Host-side pipeline executor

**src/host-pipeline-executor.ts** — new file:
- `executeHostPipeline(task: ScheduledTask, deps: PipelineDeps): Promise<void>` — main entry point called by task scheduler
- For `pipeline:sanitiser`:
  1. Query `messages` for new messages from source channels (since last run, tracked via `router_state` or similar cursor)
  2. Claim pending `intake.raw` events via `consumeEvents(['intake.raw'], 'pipeline:sanitiser', batchLimit)`
  3. For each item from either source:
     a. Insert into `observed_messages` (passive: dedup on source_chat_jid + source_message_id; intake: dedup on intake_event_id). For intake items, set `source_type='task_intake'` and populate `source_task_id`, `source_group`, `intake_reason`, `intake_event_id` from the event's `source_context`.
     b. Run Layer 1: `preprocessMessage()`. For intake items without full Slack metadata (sender_id, channel_id, subtype), Layer 1 uses `source_context` fields where available and marks absent metadata fields as unknown rather than failing.
     c. If `filtered === true`, skip Layer 2/3. Set `flags=['filtered']`, `sanitised_json=null`.
     d. Run Layer 2: `extractSemanticFields()`
     e. Run Layer 3: `postProcess()`
     f. Update `observed_messages` with `sanitised_json`, `sanitiser_model`, `sanitiser_version`, `flags`
     g. **Advance cursor** immediately after each message is fully processed (passive-channel only). This is per-message, not per-batch — if the process crashes mid-batch, only the in-flight message is re-processed on restart.
     h. If not quarantined: publish `observation.*` event (type derived from channel + urgency)
     i. If quarantined: publish `human_review_required` event
     j. For intake items: ack the `intake.raw` event as `done`, update `pipeline_intake_log` with `processed_at` and `observation_id`
  4. Log run to `task_run_logs` with aggregated token usage from all Layer 2 calls

**Crash recovery:** The cursor advances after each message (step 3g), not after the batch. If the sanitiser crashes mid-batch:
- **Passive-channel messages:** The cursor points to the last successfully processed message. On restart, processing resumes from the next message. At most one Layer 2 LLM call is wasted.
- **Intake events:** Claimed but unprocessed events remain in `claimed` status. On restart, the sanitiser re-claims them (or a background reaper returns them to `pending` after a timeout). The `observed_messages` dedup index on `intake_event_id` prevents duplicate insertions.
- **Already-processed messages:** The dedup indexes on `observed_messages` make re-inserts no-ops. The `observation.*` event dedup key (derived from observation ID) prevents duplicate events.

### Task scheduler integration

**src/task-scheduler.ts** — modify `runTask()`:
```ts
if (task.execution_mode === 'host_pipeline') {
  await executeHostPipeline(task, pipelineDeps);
  return;
}
// ... existing container path
```

The `pipelineDeps` interface provides access to db functions, LLM client (via credential proxy), config, and logger. No container is spawned. Token usage from `llm-client.ts` is logged to `task_run_logs` via `logTaskRun()` — the same path used by container tasks.

### Pipeline YAML update

Update `pipeline/sanitiser.yaml` to reflect the host_pipeline type:
```yaml
name: sanitiser
description: Extracts structured observations from raw channel messages
version: 1
type: host_pipeline
model: anthropic:haiku
cron: "*/1 * * * *"
subscribed_event_types:
  - "intake.raw"              # bumped on intake submission
source_channels:
  - "{source_channel}"        # resolved at loader time
system: |-
  You are a structured data extractor...
tools:
  default_enabled: false
  enabled: []
send_targets: []
```

### Source channel configuration

The sanitiser needs to know which channels to read from. Two approaches:
- **In the YAML spec**: `source_channels` list (resolved at loader time to JIDs via registered_groups)
- **In a separate config**: `pipeline/pipeline-config.yaml` with team_group, source_channels, etc.

Recommend the YAML spec approach — it keeps the sanitiser's configuration co-located with its definition.

### Tests
- `src/host-pipeline-executor.test.ts`: full pipeline run with mock messages, verify observed_messages populated, events published, quarantine on invalid LLM output
- Intake path: publish `intake.raw` event, run sanitiser, verify observed_messages row has `source_type='task_intake'` with intake metadata, `pipeline_intake_log` updated with `processed_at` and `observation_id`, intake event acked as `done`
- Integration with eval harness: run full pipeline against eval set, verify schema validity rate ≥ 99%
- End-to-end: register a passive channel, inject messages, run sanitiser task, verify observations and events
- End-to-end intake: call `submit_to_pipeline` from a task, verify content flows through sanitiser and produces `observation.*` event

---

## Design Decisions

1. **LLM invocation from host via credential proxy**: The sanitiser calls the Anthropic Messages API from host-side code, not via a container. API calls go through the credential proxy (`http://127.0.0.1:{CREDENTIAL_PROXY_PORT}/v1/messages`), maintaining the invariant that no code outside the credential proxy reads API keys. The `llm-client.ts` module handles HTTP requests to the proxy, token tracking, and error handling.

2. **Structured output via tool_use**: Use a single-tool schema matching `Layer2Output` to get structured JSON from the LLM. The tool is never executed — we parse the tool_use input as the extraction result. This works with all Anthropic models without requiring JSON mode support.

3. **Config-driven ticket patterns**: Ticket regex patterns are in `pipeline/sanitiser-config.yaml`, not hardcoded. New systems (JIRA projects, ServiceNow record types) are added via config changes, not code changes.

4. **Nonce wrapping at delivery time**: `sanitised_json` is stored clean in `observed_messages`. Nonce wrapping is applied when events are consumed by downstream tasks (in `consume_events` IPC handler). This keeps the audit trail readable and allows replay without nonce artifacts.

5. **Thread walking**: The sanitiser processes each message individually (including thread replies), not just top-level messages. The `read_chat_messages` query includes threaded replies. Each message becomes one observation; the monitor (Phase E) reconstructs threads from `thread_ts`.

6. **Dual input sources**: The sanitiser processes passive-channel messages and `intake.raw` events in the same run. Both go through the same three-layer pipeline. Intake events use the event bus's `bumpConsumerTaskNextRun` for sub-minute latency — no new scheduling infrastructure needed. The `pipeline_intake_log` provides a durable audit trail independent of event TTL. For intake items without full Slack metadata (sender_id, channel_id, subtype), Layer 1 uses `source_context` fields where available and marks absent metadata as unknown rather than failing — the Layer 2 LLM can still extract semantic fields from the raw text alone.

7. **Token usage logging**: The host-side pipeline executor logs token usage to `task_run_logs` via `logTaskRun()` — the same function used by container-based tasks. The `llm-client.ts` returns `{ inputTokens, outputTokens, cacheReadInputTokens, cacheCreationInputTokens, costUSD }` matching the existing `ContainerOutput.usage` shape. The executor aggregates across all Layer 2 calls in the batch and logs one `task_run_logs` row per sanitiser invocation.

## Cost estimates

Estimates assume haiku-class pricing (~$0.25/MTok input, ~$1.25/MTok output) and typical message lengths from the corpus.

| Component | Per-invocation | Frequency | Daily estimate |
|-----------|---------------|-----------|----------------|
| **Sanitiser** (Layer 2) | ~200 input + ~150 output tokens per message | 1/min cron, ~50 messages/day | ~10K input, ~7.5K output → ~$0.01/day |
| **Monitor** | ~500 input + ~300 output per batch | 1/2min cron, ~25 batches/day | ~12.5K input, ~7.5K output → ~$0.01/day |
| **Solver** (sonnet, ~$3/$15 per MTok) | ~2000 input + ~500 output per escalation | ~5 escalations/day | ~10K input, ~2.5K output → ~$0.07/day |
| **Responder** | ~200 input + ~50 output per delivery | ~5 deliveries/day | ~1K input, ~250 output → ~$0.001/day |
| **Re-extraction** (on-demand) | ~300 input + ~200 output per field | sporadic | negligible |
| **Total** | | | **~$0.09/day, ~$2.70/month** |

These are rough lower bounds. Actual costs depend on message volume, escalation rate, and model choice. The web UI's token usage chart (per-task breakdown from `task_run_logs`) provides real-time cost visibility. Switching the sanitiser or monitor to `ollama:` prefix eliminates their API cost entirely (at the expense of extraction quality and speed).

---

## Verification

1. `vitest run` — all new tests pass
2. Layer 1 eval: `npx tsx eval/run.ts --set eval/sets/golden --layer 1` — high accuracy on deterministic fields
3. Layer 2 eval: `npx tsx eval/run.ts --set eval/sets/golden --layer 2 --model anthropic:haiku` — schema validity ≥ 99%, adversarial neutralisation 100%
4. Full pipeline eval: `npx tsx eval/run.ts --set eval/sets/golden --full` — end-to-end accuracy
5. Host-side execution: configure sanitiser task, run manually, verify `observed_messages` populated and events published
6. Re-extraction: call `re_extract_observation` with valid field names, verify cached and uncached paths
7. Cost check: verify token usage per message is within haiku-class budget (~100-300 input tokens per message)
8. Intake path: `submit_to_pipeline` → `intake.raw` event → sanitiser processes → `observed_messages` row with `source_type='task_intake'` + `pipeline_intake_log` updated

## Files Summary

| File | PR | Nature |
|------|-----|--------|
| src/sanitiser/layer1.ts | 1 | **new** — deterministic pre-processor |
| src/sanitiser/layer1-config.ts | 1 | **new** — config loader |
| src/sanitiser/layer1.test.ts | 1 | **new** — tests |
| pipeline/sanitiser-config.yaml | 1 | **new** — ticket patterns, PII config |
| src/sanitiser/layer2.ts | 2 | **new** — LLM semantic extractor |
| src/sanitiser/layer2-prompt.ts | 2 | **new** — prompt template + few-shots |
| src/sanitiser/llm-client.ts | 2 | **new** — host-side LLM API client |
| src/sanitiser/layer2.test.ts | 2 | **new** — tests |
| src/sanitiser/layer3.ts | 3 | **new** — post-processor |
| src/sanitiser/nonce.ts | 3 | **new** — nonce wrapping |
| src/sanitiser/schema.ts | 3 | **new** — schema loader |
| src/sanitiser/layer3.test.ts | 3 | **new** — tests |
| src/sanitiser/nonce.test.ts | 3 | **new** — tests |
| pipeline/sanitiser-schema.yaml | 3 | **new** — field schema definition |
| container/agent-runner/src/ipc-mcp-stdio.ts | 4 | re_extract_observation tool |
| src/ipc.ts | 4 | reextract handler |
| src/db.ts | 4 | reextraction_cache table |
| container/agent-runner/src/index.ts | 4 | tool array update |
| src/host-pipeline-executor.ts | 5 | **new** — host-side task runner |
| src/task-scheduler.ts | 5 | host_pipeline branching |
| src/host-pipeline-executor.test.ts | 5 | **new** — tests |

## Cross-references

- [Phase A](OBSERVATION-PIPELINE-PHASE-A.md) — events table (Item 1), observed_messages table (Item 4), pipeline intake mechanism (Item 9), pipeline YAML loader (Item 7), host_pipeline context_mode
- [Phase C](OBSERVATION-PIPELINE-PHASE-C.md) — eval harness (Item 2), adversarial test set (Item 3), field catalog (Item 5)
- [Phase E](OBSERVATION-PIPELINE-PHASE-E.md) — monitor/solver/responder consume sanitiser output
- [OBSERVATION-PIPELINE.md](OBSERVATION-PIPELINE.md) — three-layer architecture (lines 225–312), hardening (lines 296–303), re-extraction (lines 315–340)
