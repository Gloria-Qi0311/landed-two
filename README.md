# Landed

A job-hunt workspace that does the busywork: it keeps every application on
one board and updates it from your email and candidate portals, finds new
postings for the direction you set, tailors resumes, and fills application
forms in your browser — with the AI agents you already use (Claude Code,
Codex, Gemini, Muse…), running on your own computer and subscription.

Local-first: an account's data stays in its browser unless it turns on
Landed Cloud sync.

## The parts

| | |
|---|---|
| `apps/web` | The web app: applications board, agent chat, automations, resumes, extension settings |
| `apps/server` | Accounts, Cloud data, agent relay, MCP for cloud agents; serves the web app |
| `apps/daemon` | Landed for Mac and the background service that runs agent tasks and schedules |
| `apps/extension` | Browser extension: autofill (Apply Assist) and portal status detection |
| `packages/*` | Shared schema, the observation processor (matching rules), the AI round-trip helper |

## Read next

- [CONTRIBUTING.md](CONTRIBUTING.md): set up, workflow, releases
- [docs/architecture.md](docs/architecture.md): how the pieces fit together
- [CLAUDE.md](CLAUDE.md): the rules every change follows (also what Claude Code reads)
