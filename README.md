# Road to Scratch - LINE coach

Cloudflare Worker + D1 that runs the golf & health program from `02 - LINE Coach Build Spec.md`:

- **08:45** (Bangkok) a LINE Flex message with today's AM/PM sessions, 3 video links, focus cue, tonight's bedtime and alerts
- **21:30** a 9-tap check-in (quick-reply buttons, free reply messages) that writes the `daily` row
- **Sunday 20:00** a weekly summary and, if `ANTHROPIC_API_KEY` is set, a Claude review that writes next Monday's coach note and next week's plan tweaks
- **`/`** the Road to Scratch dashboard (`source/template.html`, unchanged) running on D1 through a REST shim
- **`/api/v1`** REST API for the dashboard and for Claude

## Layout

| Path | What |
|---|---|
| `src/index.js` | Worker entry (fetch + scheduled) |
| `src/app.js` | Router: `/line/webhook`, `/api/v1/*`, `/`, `/login`, `/logout`, `/health` |
| `src/webhook.js` | Signature check, owner filter, check-in flow, text commands |
| `src/checkin.js` | Check-in state machine (pure) |
| `src/dates.js` | Asia/Bangkok date + program week logic (pure) |
| `src/program.js` | Day plan, Flex message, `today` / `plan` text, weekly overrides |
| `src/jobs.js` | Cron jobs |
| `src/claude.js` | Optional weekly Claude review |
| `src/api.js`, `src/db.js` | REST API and D1 access |
| `dashboard/rest-shim.js` | Implements `window.claude.use("db")` over `/api/v1` (poll every 30 s) |
| `source/` | Original tracker files; `build.js` now also exports `buildHtml()` |
| `scripts/build-dashboard.mjs` | Builds `src/generated/dashboard.js` (runs automatically before deploy) |
| `scripts/import.js` | Phase C: claude.ai tracker JSON exports -> SQL for D1 |
| `schema.sql` | D1 schema (safe to re-run) |

## Endpoints

| Method | Path | Auth |
|---|---|---|
| POST | `/line/webhook` | `X-Line-Signature` (HMAC-SHA256 with the channel secret) |
| GET | `/` | login cookie (otherwise redirects to `/login`) |
| GET/POST | `/api/v1/:collection` | `Authorization: Bearer <API_TOKEN>` or login cookie |
| GET/PUT/DELETE | `/api/v1/:collection/:id` | same |
| GET | `/api/v1/summary?days=14` | same |

Collections: `daily` (id = date), `rounds`, `tests`, `body` (UUID ids), `coach` (id = date), `settings` (id = key: `main`, `yardages`, `program`, `program_overrides`). List filters: `?since=YYYY-MM-DD&until=YYYY-MM-DD&limit=N`.

`settings/program` is optional. Without it the Worker uses the bundled `source/program.json`. To change the plan without redeploying, `PUT` a full program there.

## LINE commands

`today`, `plan`, `checkin`, `round 42 45 putts 33 pen 1 dbl 2 short 4 long 0 money -5000`, `body 80 82` (optional `uric 7.1`, `flare`), `dashboard`, `quota`, `help`. Before `OWNER_LINE_USER_ID` is set, the bot only answers `hello`, with the sender's user ID.

## Secrets

Never commit these. Set them in the Cloudflare dashboard as **Secret** type, or with `wrangler secret put`:

`LINE_CHANNEL_SECRET`, `LINE_CHANNEL_ACCESS_TOKEN`, `OWNER_LINE_USER_ID`, `API_TOKEN` (generate with `openssl rand -hex 32`), `ANTHROPIC_API_KEY` (optional).

Plain settings are in `wrangler.toml` `[vars]`: `TZ`, `PUSH_MONTHLY_LIMIT` (default 250; pushes stop once the month's count reaches it), `PUBLIC_URL` (optional; otherwise the dashboard link is learned from the first webhook call).

## Develop and test

Requires Node 22.5+.

```bash
npm install
npm test                      # unit + acceptance tests (in-memory SQLite stands in for D1)
cp .dev.vars.example .dev.vars   # fill in local test values
npm run db:init:local
npm run dev                   # http://localhost:8787
```

The weekly cron is written `0 13 * * SUN` rather than the spec's `0 13 * * 0`, because a day name can't be misread the way a weekday number can.
