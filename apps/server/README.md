# @landed/server

The Landed backend: a Hono API on Node + PostgreSQL. It replaced Supabase. Landed is local-first: every user signs in here, but an account's job-hunt data stays in the browser unless the account turns on **Landed Cloud sync** (`users.cloud_sync`). The server owns:

- **Auth**: email + password (scrypt) with opaque session tokens. The web app gets an httpOnly cookie and the extension gets a Bearer token. Password recovery supports standard SMTP or Cloudflare Email Sending, plus offline single-use recovery codes that do not depend on an email provider.
- **Cloud sync switch**: `POST /cloud/enable` uploads the device snapshot and turns sync on in one transaction; `POST /cloud/disable` (password) deletes the Cloud copy and turns it off, keeping the account.
- **Data**: REST endpoints for every table, scoped to the signed-in user. They only serve accounts with sync on; others get `409 { code: "cloud_off" }`.
- **Realtime**: an insert on `portal_events` fires a Postgres `NOTIFY`, which the server sends to that user over SSE at `GET /api/portal-events/stream`.
- **portal-ingest**: `POST /api/portal-ingest`, ported from the former Edge Function.
- **AI provider keys**: encrypted at rest with AES-256-GCM using `SECRETS_KEY`.
- **Agent inbox**: external agents report observations with narrow tokens. For sync-off accounts the server only relays them to the browser. See [AGENT_PROTOCOL.md](AGENT_PROTOCOL.md).
- **Web app**: in production it serves the built `apps/web/dist` at `/`.

## Local development

```sh
brew install postgresql@17 && brew services start postgresql@17
createdb landed_dev
cp apps/server/.env.example apps/server/.env   # then fill in SECRETS_KEY: openssl rand -base64 32
pnpm install
pnpm dev          # API on :8787 + Vite on :5173 (Vite proxies /api)
```

Open http://localhost:5173 and create an account. Migrations run automatically when the server starts.

Tests use a throwaway database. They **drop and recreate** the `public` schema of `TEST_DATABASE_URL`, which defaults to `landed_test`:

```sh
createdb landed_test
pnpm --filter @landed/server test
```

## Configuration (`apps/server/.env`)

| Var | Meaning |
|---|---|
| `DATABASE_URL` | Postgres connection string |
| `SECRETS_KEY` | 32 random bytes, base64. Encrypts `ai_provider_keys`. If you lose it, stored keys become unreadable. |
| `HOST` / `PORT` | Bind address. Default `127.0.0.1:8787`, which is loopback only; public traffic comes in through Cloudflare Tunnel. |
| `COOKIE_SECURE` | `true` in production (the browser connects over https). |
| `SIGNUP` | `first-only` (default) allows sign-up only while there are no users. `open` lets anyone sign up. |
| `WEB_DIST` | Built web app to serve. Default `../web/dist`. Set it to an empty value to disable. |
| `PUBLIC_URL` | Public origin used in OAuth metadata and password-reset links. |
| `EMAIL_TRANSPORT` | `smtp` (portable default) or `cloudflare`. Leave unset to disable email recovery; offline recovery codes still work. |
| `SMTP_HOST` / `SMTP_PORT` / `SMTP_SECURE` | Standard SMTP relay. Port defaults to `587`; `SMTP_SECURE` defaults to `true` only on port `465`. This can point at a self-hosted mail server. |
| `SMTP_USER` / `SMTP_PASS` | Optional SMTP credentials. Set both or neither (for a trusted local relay). |
| `CLOUDFLARE_ACCOUNT_ID` / `CLOUDFLARE_EMAIL_API_TOKEN` | Optional Cloudflare Email Sending credentials when `EMAIL_TRANSPORT=cloudflare`. |
| `EMAIL_FROM` / `EMAIL_FROM_NAME` | Sender address and display name; name defaults to `Landed`. Configure SPF, DKIM, and DMARC for public email delivery. |

## API surface

All routes are under `/api`. Every route except `/api/auth/*` and `/api/health` requires a session; everything below `/cloud/*` additionally requires Cloud sync on.

| Route | Purpose |
|---|---|
| `POST /auth/signup`, `POST /auth/login` | `{ email, password, mode? }`. With `mode: "token"` the response returns a Bearer token (extension); otherwise it sets the cookie. |
| `POST /auth/forgot-password`, `POST /auth/reset-password` | Request a 30-minute, one-use email link; consume it with `{ token, password }`. Resetting revokes every old session. |
| `POST /auth/recover-with-code` | Reset with `{ email, code, password }`. The code is consumed and every old session is revoked. |
| `POST /auth/logout`, `GET /auth/session` | Revoke the session / probe who is signed in |
| `GET/PATCH /me` | Account profile (`onboarded_at`, `cloud_sync`); works with sync off |
| `GET/POST /recovery-codes` | Inspect remaining codes or replace them after confirming the current password. Raw codes are returned once and only hashes are stored. |
| `POST /cloud/enable`, `POST /cloud/disable` | Turn Cloud sync on (body: device snapshot) / off (`{ password }`); work with sync off |
| `GET /companies`, `GET/POST /applications`, `PATCH /applications/:id`, `POST /import` | Pipeline data. `POST /applications` finds or creates the company. |
| `GET/POST /resumes`, `PATCH/DELETE /resumes/:id`, `POST /resumes/:id/current` | Resumes; at most one is current |
| `GET/PUT /portal-connections` | List / upsert on (user, company, provider) |
| `GET/POST /portal-events`, `GET /portal-events/stream` | Feed, batch insert (extension), SSE |
| `POST /portal-ingest` | One event plus an optional connection upsert |
| `POST /ai-runs` | Persist an AI round-trip |
| `GET /export`, `POST /sync/upload` | Whole-account snapshot (`landed-backup` v1) for download, and idempotent upload from a device (merges companies by name) |
| `DELETE /me` | `{ password }`: delete the account and all its rows (works with sync off) |
| `GET /ai-keys`, `PUT /ai-keys/:provider`, `DELETE /ai-keys/:id` | Write-only provider keys |
| `POST /agent/observations` | External agents (agent token, not a session). See [AGENT_PROTOCOL.md](AGENT_PROTOCOL.md) |
| `GET/POST /agent-connections`, `POST /agent-connections/:id/revoke`, `GET /agent-observations`, `GET /agent-inbox`, `POST /agent-inbox/ack` | Manage agents, review reports, relay pull for sync-off accounts. These work with sync off. |
| `GET/POST /runtimes`, `POST /runtimes/:id/revoke`, `POST /runtime-jobs`, `GET /runtime-jobs/:id/stream` | Pair the user's computers (Landed daemon), run a task on one, stream its output. Relayed in memory, never stored. |
| `POST /runtime/hello`, `GET /runtime/stream`, `POST /runtime/jobs/:id/events` | Daemon side (runtime token, not a session). See [apps/daemon](../daemon/README.md). |
| `GET /job-leads`, `PUT/PATCH /job-leads/:id`, `GET /status-suggestions`, `PUT/PATCH /status-suggestions/:id`, `GET /agent-observations/pending`, `PATCH /agent-observations/:id` | Cloud storage for the observation processor's output (it runs in the browser) |

## Production (Mac mini)

Scripted in `deploy/mac-mini/` — from your own computer, with SSH key access to the mini (`ssh-copy-id <user>@<mini>` once):

1. `deploy/mac-mini/deploy.sh` pushes the current commit straight to `~/landed` on the mini (no GitHub in between) and runs `setup.sh` there. `setup.sh` is safe to re-run; each deploy is the same command. It:
   - installs Postgres 17, Node and pnpm from Homebrew and creates the database `landed`;
   - writes `apps/server/.env` once, with a fresh `SECRETS_KEY`, `COOKIE_SECURE=true` and `SIGNUP=first-only`;
   - builds the web app and Landed for Mac (served at `/api/downloads/landed-mac.zip`);
   - runs the server under launchd (`dev.landed.server`, KeepAlive), with logs in `~/Library/Logs/Landed`;
   - backs up the database every night at 03:30 (`dev.landed.backup`, keeping 14 days in `~/Landed-backups`);
   - checks `/api/health`.
2. Make Landed public, on the mini: `deploy/mac-mini/tunnel.sh cloudflare <hostname>` (Cloudflare Tunnel on your domain; `dev.landed.tunnel`) or `deploy/mac-mini/tunnel.sh funnel` (Tailscale Funnel, no domain needed).
3. Set the public address: `PUBLIC_URL=https://<hostname> deploy/mac-mini/deploy.sh`. Cloud agents' OAuth and MCP metadata use it.
4. Add the origin to the extension's `WEB_ORIGINS` / `API_URL` (`apps/extension/lib/config.js`) and to `manifest.json`, then reload the extension.

LaunchAgents only run while the mini's user is logged in, so turn on automatic login and turn off sleep on the mini.
