# Dental Home Lead Bridge

A Cloudflare Worker that turns NxLink chatbot sessions (flow `[MY]DentalHome_v4`, tenant 4600) into leads in a Lark Base.
It polls NxLink every 2 minutes, tracks each session in Cloudflare D1, and sends two Lark webhooks per lead.
A small portal (Sessions page) shows what the bridge is tracking.

```
NxLink conversations ──(cron, every 2 min)──> Worker ──> D1 (sessions)
                                                 │
                                                 ├─ Lark "Created" webhook: Cold lead at the customer's first message
                                                 └─ Lark "Updated" webhook: verdict when the chat ends, goes quiet or reopens
```

## Lead lifecycle

| Event | When | Lark |
|---|---|---|
| Customer sends the first message | next sync (≤ 2 min) | **Created**: Lead Status Cold, Session Status Open |
| NxLink closes the chat with tags + summary | next sync, then the update goes out on the sync after (≥ 60 s after Created) | **Updated**: Lead Status from tags, summary fields |
| Customer silent for 2 h | next sync | **Updated**: Session Status Abandoned |
| Abandoned customer writes again (watched 30 h, checked hourly) | within ~1 h | **Updated**: Session Status Open |
| Chat opened but customer never typed | — | never sent |

Lead Status comes from NxLink tags (with or without the `DH - ` prefix): `Emergency` > `Hot Lead` > `Warm Lead` > `Cold Lead`, default Cold.
Name, phone, branch, date and treatment are read from the labelled summary NxLink writes when it closes a chat.
Branch is always one of the five Lark dropdown names, or left blank; when the summary gives none, the branch in Lisa's booking recap is used.
The Updated webhook leaves out unknown fields so it never blanks something staff typed in Lark.

## Code

| Path | What |
|---|---|
| `worker/session-sync.ts` | The sync: list sessions, read transcripts when needed, decide state, send webhooks |
| `worker/summary.ts` | Parses NxLink's labelled summary; maps `source_channel` to WA/FB/IG/Webchat |
| `worker/nxlink-auth.ts` | Logs in to NxLink, caches the token in KV, checks it belongs to the expected tenant |
| `worker/index.ts` | Cron handler and the portal API (`/api/sessions`, `/api/sync-sessions`) |
| `src/pages/Sessions.tsx` | Portal page |
| `migrations/` | D1 schema |

Transcripts are never stored. Budgets are sized for the Workers free plan (≤ 50 subrequests and D1 queries per run).

## Configuration

Plain settings live in `wrangler.jsonc` (`NXLINK_TENANT_ID`, `NXLINK_FLOW_NAME`, `LARK_UPDATE_DELAY_SECONDS`, `DRY_RUN`).
Secrets are set with `npx wrangler secret put <NAME>`:

- `NXLINK_ACCOUNT`, `NXLINK_PASSWORD`: a dedicated NxLink login for the tenant
- `LARK_CREATED_WEBHOOK_URL`, `LARK_UPDATED_WEBHOOK_URL`
- `PORTAL_PASSWORD`: the password for the portal and API (browser login box, any username)

Optional: `ABANDON_AFTER_MINUTES` (120), `VERDICT_WAIT_MINUTES` (15), `WATCH_HOURS` (30), `WATCH_RECHECK_MINUTES` (60), `RETENTION_DAYS`, `SYNC_START_AT` (if unset, the first live run records its own start time and earlier chats are ignored).

Every request to the portal and API needs `PORTAL_PASSWORD` (HTTP Basic Auth); if it isn't set, everything is refused.
The cron isn't affected. Cloudflare Access can replace this later for per-person logins.

## Local development

```bash
npm install
npx vite build                         # portal -> dist/
npx wrangler d1 migrations apply DB --local
npx wrangler dev --port 8787 --local   # http://localhost:8787
```

Local settings and secrets go in `.dev.vars` (gitignored). The cron doesn't run locally: press **Sync now** in the portal or call `/api/sync-sessions`.

## Deploy

```bash
npx wrangler d1 migrations apply DB --remote
npm run deploy
npx wrangler tail                      # watch the cron runs
```

Deploy with `DRY_RUN` set to `"true"` first, check the logs, then set it to `"false"` and deploy again.
