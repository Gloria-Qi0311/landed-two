# @landed/daemon

The Landed daemon connects your computer to Landed and runs Landed's AI tasks with the agent CLIs you already have installed. It works the same way as [Multica](https://github.com/multica-ai/multica):

- The tasks use your own subscription (Claude Pro or Max, ChatGPT Plus, …), so neither you nor Landed pays for API usage.
- Your computer does the work. The Landed server only relays tasks and their output, held in memory and never stored.

**Supported agents:**
- **Claude Code** — every task, including email checks (through the Gmail connector you gave Claude) and portal checks (Claude in Chrome).
- **Codex** — chat, job search and My Resume, run with `codex exec` in its read-only sandbox with the shell switched off.
- **Any agent that speaks [ACP](https://agentclientprotocol.com)** — Gemini CLI, GitHub Copilot CLI, Cursor, Goose, OpenCode, Qwen Code, Kimi, Kilo, Auggie, Cline, Devin, Factory Droid, Mistral Vibe, Qoder, Grok — the same tasks as Codex. Landed answers every permission request itself: web search and page reads when a task needs them, never editing files or running commands. An agent that runs a command anyway is stopped.

An agent is used when it is installed and signed in; `landed status` says why one isn't. To add an ACP agent that isn't on the list, put it in `~/.landed/agents.json`:

```json
[{ "id": "my-agent", "label": "My Agent", "command": "/usr/local/bin/my-agent", "args": ["acp"] }]
```

## Use it

**On a Mac:** in Landed, open **Agent → Connect this computer**.
- The first time, Landed offers **Landed for Mac**. Download it and open it once. It installs the daemon as a background service: the service starts with your Mac, restarts if it stops, and never needs a terminal.
- From then on, *Connect this computer* opens the app. It asks "Connect this Mac to Landed at …?", and you click **Connect**. That confirmation is there because any web page can open a `landed://` link, and pairing should never happen without your click.

Build the app with `pnpm --filter @landed/daemon build:mac`. That writes `dist/Landed.app` and `dist/Landed-mac.zip`; the Landed server serves the zip at `/api/downloads/landed-mac.zip`. Add `--install` to also copy the app to `~/Applications` on this Mac. The app is ad-hoc signed and not notarized, so the first time a *downloaded* copy is opened, macOS may ask you to confirm it in System Settings → Privacy & Security.

### Apply Assist

Landed for Mac is a native menu-bar app. Open it and use the Landed L icon to choose up to five application pages, select a resume, and start a fill without opening an extension panel. It carries lightweight Safari and Chromium extensions that give the menu app access to the form DOM.

Safari: click **Safari Extension** in the menu app, then enable Landed in Safari Settings → Extensions. The extension is embedded in `Landed.app` and talks to the daemon only over `127.0.0.1`; the app wakes it when a Safari fill is requested.

Each Chromium browser/profile needs its extension once: load `~/.landed/extension` from its extensions page (Developer mode → **Load unpacked**). The menu app has a **Chromium Extension** button for this step. Chrome, Brave, Edge, and Chromium can all connect to the same menu app.

Local builds use Xcode's **Sign to Run Locally** identity. Safari requires Develop → **Allow Unsigned Extensions** for that development build. A Developer ID/App Store release removes that development-only step.

When the menu app fills selected pages, known fields use deterministic extension rules. Unknown labels are sent directly to local Ollama through the native host; they never pass through the Landed server. The local model may only choose an existing resume key, and the daemon supplies that key's original value after validation. The bridge outlines filled fields green and fields needing review yellow. It never clicks the final submit button.

The preferred model is `qwen3.5:4b`; set `LANDED_OLLAMA_MODEL` in the native-host environment to override it. If that model is absent, Landed tries `qwen3.5:9b`, another local Qwen model, then the first installed Ollama model. Without Ollama, deterministic filling still works and unknown fields remain for review.

**From a terminal (any OS, from the repo):**

```sh
pnpm landed connect --server https://your-landed --token landed_rt_…   # pair + run here
pnpm landed start                                                       # run again later
pnpm landed status                                                      # what's paired, which agents were found
pnpm landed fill-trace K7Q2MX                                           # what one autofill did (the ref the extension showed)
```

`fill-trace` reads one of your fill traces with this computer's pairing (Landed Cloud accounts keep them 30 days; `--json` prints the raw trace). See docs/apply-assist.md, "Fill traces".

Only one daemon runs per computer (`~/.landed/daemon.pid`). If the background service is installed, `connect` hands it the new connection instead of starting a second daemon. `pnpm landed uninstall` removes the service.

You need Node 23.6+ and at least one supported agent CLI, installed and signed in. Removing the computer in Landed revokes its key. A terminal daemon then exits, and the service waits for a new connection.

## What an agent can do here

- Tasks come from a fixed set of kinds:
  - `chat`: one turn of the conversation on Landed's Agent page. Once your direction is clear, the agent proposes a search brief, which Landed shows as a card.
  - `job_search`: after you confirm a brief, the agent searches the web for open postings that match it. It returns them as schema-checked JSON, and they land in your Leads column.
  - `email_check`: only offered if your agent can read email, and only once you turn on email watching in Landed. To give Claude Code email access, connect Gmail in Claude (claude.ai → Settings → Connectors). The daemon allows only the mailbox's read tools, never send, draft, label or delete.
  - `portal_check`: when an application has gone quiet and you click "Look at its portal" in Landed — or on a schedule, if you turn on *Check candidate portals* on the Automation page — the agent opens its candidate portal (Workday, LinkedIn, Handshake, …) in your Chrome through Claude in Chrome and reads the status. It is read-only by construction: it gets the tools to open tabs, navigate and read pages, and no tool to click, type, fill forms, run scripts or read network traffic. It never signs in; a portal behind a login comes back as "needs you to sign in". Tip: connect Claude in Chrome in a Chrome profile that is only signed in to job sites.

  - `resume_parse`: reads a resume you uploaded in Landed. PDFs and images are saved to a temporary folder in `~/.landed/workspace/uploads`. Claude Code may read that one file and nothing else; other agents get the PDF's text (read by macOS) or the image itself, and no file access. The folder is deleted when it's done.
  - `resume_merge` / `resume_tailor`: My Resume. These merge your uploaded resumes into one master resume, keeping every phrasing of every bullet, and tailor versions from it for a role. Both are text work only, with no tools or connectors; tailoring may read the job posting when it only has a link.

  - `automation_sync`: Landed's Automation page. The daemon keeps the schedule you set (email checks, job searches) in `~/.landed/automations.json` and runs it itself, so it works even when Landed is closed. Results wait there until Landed is open again and has stored them.

  The daemon re-checks what your agent can do (mail connector, Chrome) every 30 minutes, so connecting Gmail or Chrome needs no restart. claude.ai connectors don't always load in `claude -p`, so the last good mailbox lookup is kept in `~/.landed/capabilities.json`. An email or portal check that never reached the mailbox or Chrome reports an error and doesn't count as a check, so no email is skipped. `pnpm landed status` shows what was found. After updating Landed itself, restart the daemon (`pnpm landed start`) to pick up new code.

  If an email check says Claude Code is signed out, pairing the computer again
  will not repair it: the Landed pairing and the Claude account are separate.
  Run `claude auth login` in Terminal and finish the browser sign-in. If the
  next check still cannot load Gmail, reconnect Gmail in Claude → Settings →
  Connectors. Landed re-checks automatically within 30 minutes; no failed check
  advances the email window.
- Your message reaches the agent on stdin and never passes through a shell.
- The agent runs in an empty `~/.landed/workspace`. It ignores your own Claude Code settings and hooks (`--setting-sources ""`).
- Chat and search only get read-only web tools (WebSearch, WebFetch), and none of your MCP connectors load. Email checks only get your mailbox's read tools. Portal checks only get Chrome's open-tab, navigate and read tools, with no other connector loaded. The agent never gets file access or a shell.

`~/.landed/config.json` holds the server URL and this computer's key (mode 600). `LANDED_HOME` moves the whole folder somewhere else.
