# Working on Landed

How to run Landed on your own machine, how changes get in, and how they ship.
The rules every change follows (local-first data, what agents may do, the
Apply Assist safety rules, visual style) are in [CLAUDE.md](CLAUDE.md). Claude
Code reads it on every session. How the parts fit together is in
[docs/architecture.md](docs/architecture.md), and each area has its own doc in
[docs/](docs/): read the one for the area you're changing first.

## What's where

| Path | What it is |
|---|---|
| `apps/web` | The Landed web app (Vite + React). Data lives in the browser (IndexedDB) unless the account turns on Cloud sync. |
| `apps/server` | API + Postgres (Hono). Accounts, Cloud data, the agent relay, MCP for cloud agents. Also serves the built web app. |
| `apps/daemon` | Runs on the user's computer: agent tasks with their own Claude Code / Codex / ACP agents, scheduled automations, and Landed for Mac (menu bar app, self-updating). |
| `apps/extension` | Browser extension: Apply Assist autofill, portal status detection. Chrome/Edge/Brave, and Safari through Landed for Mac. |
| `packages/schema` | Shapes and validators shared by web, server, daemon. |
| `packages/observation-processor` | The only place matching / auto-apply rules live. |
| `docs/` | Architecture and one doc per area; `docs/history/` keeps early notes and the first prototype. |

## Set up

You need Node 24 (`nvm use` reads `.nvmrc`), pnpm 10 (`corepack enable`) and
Postgres 17 (`brew install postgresql@17`, then `brew services start postgresql@17`).

```sh
git clone https://github.com/AntaresYuan/landed.git
cd landed
corepack enable
pnpm install

createdb landed_dev      # your local data
createdb landed_test     # the server tests wipe and re-create this one

cp apps/server/.env.example apps/server/.env
# in apps/server/.env: SECRETS_KEY=$(openssl rand -base64 32) and SIGNUP=open

pnpm dev                 # server on :8787, web on http://localhost:5173
```

Sign up on http://localhost:5173 with any email — it's your local server.

Optional, depending on what you work on:

- **Agents** (chat, job search, resume parsing): install [Claude Code](https://claude.com/claude-code)
  and pair your computer from the Agent page, or run `pnpm landed connect '<link from the Agent page>'`.
- **Extension**: `pnpm --filter @landed/extension build`, then in Chrome → Extensions → Developer mode →
  Load unpacked → `apps/extension/dist`. It talks to the production server by default
  (`API_URL` in `apps/extension/lib/config.js`); the page bridge works with `localhost` too.
- **Local AI for autofill**: [Ollama](https://ollama.com) with a small model (`ollama pull qwen3.5:4b`).
- **Landed for Mac**: `pnpm --filter @landed/daemon build:mac` (the Safari extension needs full Xcode).

Never point anything at the production database, and never use real people's
data in tests or fixtures — use made-up names, emails and phone numbers.

## Before you push

Run what CI runs:

```sh
pnpm typecheck && pnpm lint && pnpm test
```

## How changes get in

- `main` is what runs in production. Nobody pushes to it directly.
- One branch per change: `git checkout -b <your-name>/<what>` (e.g. `kai/workday-dates`).
- Open a pull request into `main`. CI (`.github/workflows/ci.yml`) runs typecheck, lint and every
  test; the other person reviews; then **squash-merge**.
- Commit messages describe what changed and why. Don't add `Co-Authored-By` trailers (see CLAUDE.md).
- A new product rule or convention goes into CLAUDE.md (one line) and the area doc in `docs/`, in the same PR.
- Two people (or two Claude Code sessions) shouldn't work on the same branch at once. If you share
  files, pull first and keep the PR small.
- Database changes are new files in `apps/server/migrations/` — never edit an applied migration. A new
  migration or browser database version (Dexie) takes the next number after the highest one in `main`;
  put that number in the PR title so two PRs don't take the same one.

## Releasing

Releases are done by the repo owner for now:

- **Web + server**: `deploy/mac-mini/deploy.sh` from a clean checkout of `main` pushes it to the Mac mini
  and restarts the service.
- **Landed for Mac**: `deploy.sh` also builds, signs and publishes the app on the owner's machine.
  Installed apps update themselves, and only to builds signed with the release key, which never
  leaves that machine (`~/.landed-release`).

Secrets (`apps/server/.env`, the release key, SMTP passwords) are never committed.
