# Observation Pipeline — Post-Work

Outstanding items discovered during initial deployment and testing. None are blockers for the current autonomous-solver mode.

## 1. Slack reaction handler for approval flow

The reaction bridge (`src/reaction-bridge.ts`) is wired into `src/index.ts` but Slack doesn't deliver reaction events yet.

**What's needed:**
- Add `reaction_added` event listener in `src/channels/slack.ts` alongside the existing `message` handler
- Normalize Slack reaction events into the `Reaction` interface (`emoji`, `userId`, `messageId`, `chatJid`, `timestamp`)
- Call `channelOpts.onReaction(chatJid, reaction)` to dispatch to the bridge

**What changes when this ships:**
- Remove `send_cross_channel_message` from the solver's tool list — it should only post proposals in the team channel
- The responder becomes the sole path to the source channel, gated by human reaction
- Thumbsup → approved_reply → responder delivers threaded reply
- Thumbsdown → proposal rejected, no reply sent
- Speech balloon → edit flow (follow-up message intercepted, edited text delivered)

## 2. DB prompt backup

Pipeline task prompts (domain-specific, with tool names) live only in the DB. If the DB is lost or reset, the prompts revert to the generic YAML defaults.

**What's needed:**
- Script to export pipeline task prompts to the private repo
- Run on demand or as part of a backup routine
- Format: one file per task, or a single YAML/JSON dump

## 3. Solver PagePilot integration

The solver has `pp_list`, `pp_run`, `pp_get`, `pp_run_result` in its tool list but doesn't reliably discover relevant scripts. The prompt says "search for relevant monitoring scripts" but the solver often skips straight to system health checks.

**What's needed:**
- Better prompt guidance or few-shot examples showing the pp_list → pp_run → pp_run_result workflow
- Consider a pre-built mapping of issue keywords to PagePilot script names (stored in the private config)

## 4. Monitor clustering refinement

The monitor currently treats each observation independently (stateless v1). Cross-day continuations and multi-message clusters are handled by the LLM's ability to match tickets and participants, but accuracy depends on prompt quality.

**What's needed (if clustering quality is insufficient):**
- Add a `clusters` table tracking active clusters, their observations, and status
- Monitor maintains cluster state across invocations
- This is Option B from the original design spec (section "Cluster state")
