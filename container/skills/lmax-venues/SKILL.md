---
name: lmax-venues
description: LMAX venues, how to check that prices are flowing, and when they are expected to be serving live prices
---

# LMAX Venues

## Venue Categories

| Category | Naming Rule | Examples |
|----------|-------------|---------|
| Digital | Name starts with "Digital" | Digital London, Digital Singapore |
| Perps | Name starts with "Perp" | Perps London |
| UAT | Name ends in "UAT" | Any venue ending in "UAT" (e.g. "FIAT UAT") |
| FIAT | All other venues | LD4 T1, SG1 T1, LD6 Global, LDN MTF, etc. |

A venue can belong to multiple categories. For example, "FIAT UAT" is both a FIAT venue and a UAT venue.

## How to Check Prices

Open the feed status page: `https://monitor-prod1.lmaxglobal.io/feedstatus`

This page shows the state of price feeds for various trading venues (listed down the page, with names on the left) and for various instances of the price feed servers (columns, left to right).

| Cell Colour | Meaning | Action |
|-------------|---------|--------|
| **Green** | Prices are flowing | No action needed |
| **Orange** | Brief interruption — may be self-healing | Not an error, but persistent orange may be worth reporting |
| **Red** | Feed instance is not working | Error only if unexpected (see rules below) |

## What to Report

Only report a venue as having an issue if it is **unexpectedly red**. Specifically:

- **Unexpectedly red** → error, should be reported
- **Persistently orange** → not an error, but may be reported on
- **Unexpectedly green** (e.g. during a maintenance window) → NOT an error, do not report
- **UAT venues not pricing** → NOT an error, do not report (UAT venues may be stopped at any time)
- **Any Digital PRX venue** (e.g. Digital PR11, Digital PR12, etc.) → disregard entirely, any status is expected

## Trading Day

A trading day starts at **17:00 New York time** and runs until 17:00 the following day.

## Maintenance Windows

All times are **New York time**.

### Daily — All Venues

| Window | Days | Venues Affected |
|--------|------|-----------------|
| 17:00 – 17:05 | Every day | All venues |

### Digital Venues — Weekly

| Window | Days | Venues Affected |
|--------|------|-----------------|
| 17:00 – 18:00 | Every Friday | All Digital venues |

### Perps London — Biweekly

| Window | Days | Venues Affected |
|--------|------|-----------------|
| 17:00 – 17:30 | Every other Friday (from 13 March 2026, inclusive) | Perps London only |

The biweekly Fridays for Perps London: 13 Mar 2026, 27 Mar 2026, 10 Apr 2026, 24 Apr 2026, and so on (every 14 days from the 13 Mar 2026 anchor).

### FIAT Venues — Weekend

| Window | Days | Venues Affected |
|--------|------|-----------------|
| 17:00 Friday – 17:05 Sunday | Every weekend | All FIAT venues **except**: LD4 T1, SG1 T1, LD6 Global, LDN MTF (synthetic) |

The four exempt FIAT venues (LD4 T1, SG1 T1, LD6 Global, LDN MTF) only observe the daily 5-minute maintenance window, not the weekend shutdown.

## Determining Expected Status

To check whether a venue should currently be showing live prices:

1. Get the current time in New York (`America/New_York`).
2. Determine the day of week.
3. Check each maintenance window in order:
   - **All venues**: Is it between 17:00 and 17:05 on any day? → maintenance
   - **Digital venues**: Is it Friday between 17:05 and 18:00? → maintenance
   - **Perps London**: Is it a biweekly Friday (14-day cycle from 13 Mar 2026) between 17:05 and 17:30? → maintenance
   - **FIAT venues** (excluding LD4 T1, SG1 T1, LD6 Global, LDN MTF): Is it between Friday 17:05 and Sunday 17:05? → maintenance
4. If the venue is a **UAT** venue (name ends in "UAT"), it may be stopped at any time — this is never an error.
5. If the venue is a **Digital PRX** venue (any venue matching "Digital PR*"), disregard — any status is expected.
6. If none of the maintenance windows apply, the venue is expected to be green. If it is red, this is an error and should be reported.
7. If a venue is green during a maintenance window, this is NOT an error — do not report it.
