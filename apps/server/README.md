# @landed/server

The Landed backend: a Hono API on Node + PostgreSQL. It replaced Supabase and owns:

- **Auth**: email + password (scrypt) with opaque session tokens. The web app gets an httpOnly cookie and the extension gets a Bearer token.
- **Data**: REST endpoints for every table. Each query is scoped to the signed-in user.
- **Realtime**: an insert on `portal_events` fires a Postgres `NOTIFY`, which the server sends to that user over SSE at `GET /api/portal-events/stream`.
- **portal-ingest**: `POST /api/portal-ingest`, ported from the former Edge Function.
- **AI provider keys**: encrypted at rest with AES-256-GCM using `SECRETS_KEY`.
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

## API surface

All routes are under `/api`. Every route except `/api/auth/*` and `/api/health` requires a session.

| Route | Purpose |
|---|---|
| `POST /auth/signup`, `POST /auth/login` | `{ email, password, mode? }`. With `mode: "token"` the response returns a Bearer token (extension); otherwise it sets the cookie. |
| `POST /auth/logout`, `GET /auth/session` | Revoke the session / probe who is signed in |
| `GET/PATCH /me` | Profile (`onboarded_at`) |
| `GET /companies`, `GET/POST /applications`, `PATCH /applications/:id`, `POST /import` | Pipeline data. `POST /applications` finds or creates the company. |
| `GET/POST /resumes`, `PATCH/DELETE /resumes/:id`, `POST /resumes/:id/current` | Resumes; at most one is current |
| `GET/PUT /portal-connections` | List / upsert on (user, company, provider) |
| `GET/POST /portal-events`, `GET /portal-events/stream` | Feed, batch insert (extension), SSE |
| `POST /portal-ingest` | One event plus an optional connection upsert |
| `POST /ai-runs` | Persist an AI round-trip |
| `GET /ai-keys`, `PUT /ai-keys/:provider`, `DELETE /ai-keys/:id` | Write-only provider keys |

## Production (Mac mini)

1. `brew install postgresql@17 node pnpm cloudflared`, start Postgres with `brew services`, then `createdb landed`.
2. Clone the repo, run `pnpm install && pnpm --filter @landed/web build`, and write `apps/server/.env` with `COOKIE_SECURE=true`.
3. Run `node --env-file=.env src/index.ts` from `apps/server` under launchd with `KeepAlive`.
4. Set up a Cloudflare Tunnel whose ingress points `https://<your-hostname>` at `http://127.0.0.1:8787`.
5. Set `API_URL` in `apps/extension/lib/config.js` to that hostname and rebuild the extension.
6. Back up Postgres on a schedule with `pg_dump`.
