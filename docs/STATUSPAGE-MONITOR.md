# Statuspage Monitor

Monitor statuspage.io maintenance window notifications via a dedicated Slack channel.

## Overview

statuspage.io posts maintenance window notifications to a shared company Slack channel. NanoClaw should react to these in near-real-time, but cannot register the company channel as a group (it's shared across the whole company).

## Design

Create a **dedicated Slack channel** for NanoClaw to receive statuspage notifications. Either:
- Configure statuspage.io to also post to this new channel, or
- Set up a Slack workflow/mirror to forward from the company channel to the new one

Register the new channel as a NanoClaw group with:
- `requiresTrigger: false` — every message triggers an agent run immediately
- Folder: `slack_statuspage-alerts` (or similar)
- Model: haiku (sufficient for parsing structured notifications, keeps cost low)

## Group CLAUDE.md

The group's `CLAUDE.md` should instruct the agent that:

1. Incoming messages are **NOT user commands** — they are automated notifications from statuspage.io about services entering or leaving maintenance windows
2. Parse the maintenance window details: service name, status (investigating, identified, monitoring, resolved), scheduled time
3. Take the appropriate action (TBD — e.g. notify another channel, update a tracking file, pause/resume related tasks)
4. If nothing actionable, wrap output in `<internal>` tags to suppress it

Example CLAUDE.md template:

```markdown
# Statuspage Monitor

You monitor statuspage.io maintenance notifications.

Incoming messages are NOT user commands. They are automated notifications about
services entering or leaving maintenance windows.

When you receive a message:
1. Parse the maintenance window details (service, status, time)
2. [action TBD]
3. If nothing actionable, wrap your output in <internal> tags to suppress it.
```

## Setup Steps

1. Create a new Slack channel (e.g. `#nanoclaw-statuspage`)
2. Invite the NanoClaw Slack bot to the channel
3. Configure statuspage.io or a Slack workflow to forward notifications to it
4. Register the channel as a group via the main group agent's `register_group` tool:
   - JID: `slack:<NEW_CHANNEL_ID>`
   - Name: `Statuspage Alerts`
   - Folder: `slack_statuspage-alerts`
   - Trigger: `@<ASSISTANT_NAME>` (unused but required by schema)
5. Set `requires_trigger` to `0` in the DB for the new group
6. Create `groups/slack_statuspage-alerts/CLAUDE.md` with the agent instructions
7. Test by posting a sample statuspage-style message in the new channel

## Open Questions

- What actions should the agent take on maintenance start/end?
- Which model to use (haiku is cheapest, sonnet if more reasoning needed)
- Whether `register_group` MCP tool should support `requires_trigger` directly (currently requires a manual DB update in step 5)
