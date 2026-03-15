---
name: lmax-venues
description: LMAX venues, how to check that prices are flowing, and when they are expected to be serving live prices
---

# LMAX Venues

You have two MCP tools for monitoring LMAX trading venues. **Always use these tools** rather than trying to check feed status manually or replicate maintenance window logic yourself.

## Tools

### `mcp__lmax-venues__check_venue_status`

Check whether venues are pricing as expected. Fetches live feed status, applies maintenance window rules, and returns only anomalies.

- Call with no arguments to check all venues.
- Pass `venues: ["Venue Name"]` to filter to specific venues.
- Pass `include_ok: true` to also see venues that are healthy (for diagnostics).

The response includes:
- `venue_code` — short identifier (e.g. `ld4t1`, `perpld`, `diglnd`)
- `venue` — full venue name (e.g. "LD4 T1", "Perps London", "Digital London")
- `anomalies` — venues that are unexpectedly red or persistently orange
- `active_maintenance_windows` — any maintenance windows currently in effect
- `summary` — one-line status overview

When reporting results, include both the venue name and venue code.

### `mcp__lmax-venues__get_maintenance_schedule`

Get current and upcoming maintenance windows.

- Pass `hours_ahead: 48` to look further into the future (default: 24 hours).
- Pass `venue: "name"` to filter to windows affecting a specific venue.

## How to Respond

1. **Call the tool first.** Do not guess or calculate maintenance windows yourself — the tool has the authoritative schedule.
2. **Relay the tool's response.** Summarise for the user but do not omit anomalies or venue codes.
3. **Only report genuine anomalies.** The tool already filters out expected maintenance and ignored venues. If `anomaly_count` is 0, all venues are healthy.
4. **Include venue codes** when listing venues (e.g. "LD4 T1 (`ld4t1`)").

## Background Reference

This section is for your understanding only — the MCP tools handle all this logic automatically.

### Venue Categories

| Category | Naming Rule | Examples |
|----------|-------------|---------|
| Digital | Name starts with "Digital" | Digital London, Digital Singapore |
| Perps | Name starts with "Perp" | Perps London |
| UAT | Name ends in "UAT" | Any venue ending in "UAT" (e.g. "FIAT UAT") |
| FIAT | All other venues | LD4 T1, SG1 T1, LD6 Global, LDN MTF, etc. |

### Feed Status Colours

| Cell Colour | Meaning |
|-------------|---------|
| **Green** | Prices are flowing |
| **Orange** | Brief interruption — may be self-healing |
| **Red** | Feed instance is not working |

### Key Rules (handled by the tool)

- UAT venues may be stopped at any time — never an error.
- Digital PRX and Digital PR11 are disregarded entirely.
- A venue that is green during a maintenance window is NOT an error.
- The trading day starts at 17:00 New York time.
- All maintenance windows are in New York time.
