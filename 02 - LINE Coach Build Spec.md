---
title: Road to Scratch - LINE Coach Build Spec
author: Supawat Pugkhem
company: Green Cluster
subject: Automating the golf & health program with LINE OA, Cloudflare Workers and Claude
created: 2026-10-13
---

# Road to Scratch - LINE Coach Build Spec

Hand this file to Claude Code (on your Mac or Linux server, logged in to your GitHub and Cloudflare). Source files for the current tracker are in `source/` next to this file.

## 1. Goal

One system where:
- LINE sends the day's plan every morning (sessions + video links) and a check-in at night.
- Supawat answers the check-in by tapping buttons in LINE (10 seconds).
- A web dashboard (the Road to Scratch page) shows progress.
- Claude reviews the data weekly and adjusts the plan.

## 2. Phases

| Phase | What | Status |
|---|---|---|
| A | Claude scheduled tasks: 08:45 coach note written into the claude.ai tracker + phone push; 21:25 check-in reminder push | Live from 14 Oct 2026 |
| B | LINE bot + dashboard on Cloudflare Workers (this spec) | To build with Claude Code |
| C | Migrate data from the claude.ai tracker into the new database; switch off Phase A | After B is tested |

## 3. Recommended architecture (free)

```
LINE app  <-->  LINE Messaging API  <-->  Cloudflare Worker (https://road-to-scratch.<account>.workers.dev)
                                              |-- D1 database (SQLite)
                                              |-- Cron Triggers (morning, evening, weekly)
                                              |-- Static dashboard (Road to Scratch page)
                                              '-- Anthropic API (weekly review, optional)
GitHub repo  -->  wrangler deploy (or Cloudflare Workers Builds from GitHub)
```

Why Cloudflare Workers:
- Free plan: 100,000 requests/day, 5 cron triggers, free HTTPS on `*.workers.dev` (LINE requires HTTPS with a trusted certificate; self-signed is rejected).
- No server, no port forwarding, always on.
- Limit to respect: 10 ms CPU per invocation on the free plan (waiting on fetch does not count). Keep handlers light.

Fallback (if you prefer self-hosting): the same app as a Node container on the Linux Docker host, behind Caddy on port 443 with automatic Let's Encrypt for the DynDNS WebHop hostname. Same endpoints and schema; swap D1 for SQLite and cron triggers for node-cron.

## 4. LINE setup (Supawat does this - keep secrets out of chat)

1. LINE Developers Console > Provider > create (or link) a **Messaging API channel** for the existing LINE OA.
2. Copy the **Channel secret** and issue a **Channel access token (long-lived)**.
3. In LINE OA Manager: turn off auto-reply and greeting messages (they clash with the bot).
4. After deploy: set Webhook URL to `https://<worker>/line/webhook`, press Verify, enable "Use webhook".
5. Add the OA as a friend; send "hello" - the bot replies with your LINE user ID; save it as `OWNER_LINE_USER_ID`.

Message budget: about 2 push messages/day + 1 weekly = ~65/month. The Thai free plan allows about 300 push messages/month (check OA Manager). Check-in answers use reply messages, which do not count toward the quota.

## 5. Secrets and config (wrangler secrets - never committed)

| Name | Purpose |
|---|---|
| LINE_CHANNEL_SECRET | Verify `X-Line-Signature` on webhooks |
| LINE_CHANNEL_ACCESS_TOKEN | Push and reply messages |
| OWNER_LINE_USER_ID | Only respond to Supawat; ignore everyone else |
| API_TOKEN | Bearer token for `/api/*` (dashboard and Claude) |
| ANTHROPIC_API_KEY | Optional - weekly review (billed separately from the Claude subscription) |
| TZ | `Asia/Bangkok` (all date logic in Bangkok time) |

Protect the dashboard with **Cloudflare Access** (free for small teams, email one-time PIN) or with the API token in a cookie after a login page.

## 6. Data model (D1) - mirrors the current tracker collections

```sql
CREATE TABLE daily   (date TEXT PRIMARY KEY, woke INT, trained INT, mobility INT, screens INT,
                      drinks INT, practice INT, water REAL, energy INT, note TEXT, week INT, updated TEXT);
CREATE TABLE rounds  (id TEXT PRIMARY KEY, date TEXT, course TEXT, tee TEXT, sleep REAL, drinks INT,
                      front INT, back INT, fw INT, gir INT, putts INT, threePutts INT, penalties INT,
                      doubles INT, apShort INT, apLong INT, money INT, mind INT, note TEXT, created TEXT);
CREATE TABLE tests   (id TEXT PRIMARY KEY, date TEXT, dSpeed REAL, dCarry REAL, dDir REAL, iSpeed REAL,
                      iBall REAL, iCarry REAL, iSpread REAL, iDir REAL, wedge INT, p6 INT, lag INT,
                      note TEXT, created TEXT);
CREATE TABLE body    (id TEXT PRIMARY KEY, date TEXT, weight REAL, waist REAL, uric REAL, flare INT,
                      note TEXT, created TEXT);
CREATE TABLE settings(key TEXT PRIMARY KEY, json TEXT);   -- program, main (cap), yardages
CREATE TABLE coach   (date TEXT PRIMARY KEY, title TEXT, message TEXT, alerts TEXT, created TEXT);
CREATE TABLE convo   (user_id TEXT PRIMARY KEY, flow TEXT, step INT, draft TEXT, updated TEXT);
```

`settings.program` holds `program.json` (12-week plan, weekly template, sessions with `||search terms` for video links, rules).

## 7. Endpoints

| Method | Path | Notes |
|---|---|---|
| POST | /line/webhook | Verify HMAC-SHA256(raw body, channel secret) == base64 `X-Line-Signature`; ignore non-owner users; handle `message`, `postback`, `follow` |
| GET | / | Dashboard: the Road to Scratch page served as static HTML |
| GET/PUT/DELETE | /api/v1/:collection/:id | Bearer API_TOKEN |
| GET/POST | /api/v1/:collection | List / create |
| GET | /api/v1/summary?days=14 | Compact JSON for Claude reviews |

Dashboard reuse: the current page talks to `window.claude.use("db")` (collection/doc/onSnapshot/set/add/delete). Add a small **REST shim** that implements the same interface over `/api/v1` (onSnapshot = fetch + poll every 30 s). Then the existing page runs unchanged.

## 8. Scheduled jobs (cron, Asia/Bangkok -> UTC in wrangler.toml)

| Bangkok time | UTC cron | Job |
|---|---|---|
| 08:45 daily | `45 1 * * *` | Morning push: title, today's AM/PM sessions (from template by weekday + current week), 3 most relevant exercise video links, focus cue, tonight's bedtime, alerts (drinking-night limit, missed session yesterday). Use a LINE Flex message with buttons "Open dashboard" and "Today's full plan". |
| 21:30 daily | `30 14 * * *` | Evening check-in push with quick-reply buttons (see 9). Skip if today already logged. |
| Sun 20:00 | `0 13 * * 0` | Weekly summary push (habit %, drinking nights, workouts, practice minutes, rounds and money). If ANTHROPIC_API_KEY is set: send `/api/v1/summary` + program to Claude, store the reply as next week's coach notes and plan tweaks (written to `settings.program_overrides`). |

Bedtime and wake targets come from `program.weeks[n-1].sleep`; Week 1 starts Monday 2026-10-19.

## 9. LINE check-in flow (reply messages, free)

Each step is a question with quick-reply buttons (postback data `ci:<field>:<value>`). Store progress in `convo`; on the last answer upsert `daily` for today and reply with the summary ("4/5 habits - screens off by 23:45").

1. Woke on time? - Yes / No
2. Did the planned session? - Yes / 20-min version / No
3. Mobility 10 min? - Yes / No
4. Screens off on time last night? - Yes / No
5. Drinks today? - 0 / 1 / 2 / 3 / 4+
6. Golf practice? - 0 / 30 / 60 / 90 min
7. Water? - 1 / 2 / 2.5 / 3+ L
8. Energy today? - 1 / 2 / 3 / 4 / 5
9. Note? - "Skip" button, or type any text

Text commands: `today` (full plan with all video links), `plan` (this week), `round 42 45 putts 33 pen 1 dbl 2 short 4 long 0 money -5000` (quick round log; anything unclear -> ask), `body 80 82` (weight, waist), `dashboard` (link), `help`.

## 10. Migration from the claude.ai tracker (Phase C)

Claude exports every collection from the Road to Scratch artifact (ArtifactData list) to JSON files; an import script (`scripts/import.js`) loads them into D1 with `wrangler d1 execute`. After a week of parallel running, disable the two Claude scheduled tasks.

## 11. Acceptance tests

- Webhook rejects a bad signature (401) and ignores non-owner users.
- "hello" returns the owner user ID only before OWNER_LINE_USER_ID is set.
- Morning job on a Friday in Week 1 lists "Strength C" and "Pilates reformer A" with video links.
- Full check-in by buttons creates the `daily` row; repeating it the same day updates the row.
- Dashboard shows the same data as the API; API without token returns 401.
- Message count per month stays under the free quota.

## 12. Kick-off prompt for Claude Code

Recommended route: Claude Code on the web (claude.ai/code) with the Claude GitHub App installed on an empty private repo `road-to-scratch`. Upload this spec and the `source/` folder to the repo first (GitHub > Add file > Upload files). Deploy with Cloudflare's GitHub integration (Workers & Pages > Create > import the repo), so every push deploys automatically and no Cloudflare token is needed in Claude.

> Build the Road to Scratch LINE coach described in `02 - LINE Coach Build Spec.md` in this repo. Scaffold a Cloudflare Worker (JavaScript, wrangler, D1) with the schema, endpoints, cron jobs and LINE check-in flow in the spec. Reuse `source/template.html`, `source/program.json` and `source/build.js` for the dashboard and add the REST shim. Write unit tests for signature verification, the check-in state machine and the date/week logic (Asia/Bangkok). Then walk me through `wrangler login`, creating the D1 database, setting secrets (I will type them myself), deploying, and setting the LINE webhook URL.
