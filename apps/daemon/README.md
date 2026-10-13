# @landed/daemon

The Landed daemon connects your computer to Landed and runs Landed's AI tasks with the agent CLIs you already have installed. It works the same way as [Multica](https://github.com/multica-ai/multica):

- The tasks use your own subscription (Claude Pro or Max, ChatGPT Plus, …), so neither you nor Landed pays for API usage.
- Your computer does the work. The Landed server only relays tasks and their output, held in memory and never stored.

**Supported agents:** Claude Code. Codex and Gemini CLI are next.

## Use it

1. In Landed, open **Agent → Connect this computer** and copy the command.
2. Run it in a terminal on that computer, from the Landed repo folder:

   ```sh
   pnpm landed connect --server https://your-landed --token landed_rt_…   # pair + run
   pnpm landed start                                                       # later: run again
   pnpm landed status                                                      # what's paired, which agents were found
   ```

You need Node 23.6+ and at least one supported agent CLI, installed and signed in. Keep the daemon running for Landed to reach the agents; your Mac mini is a good always-on host. Removing the computer in Landed revokes its key, and the daemon exits.

## What an agent can do here

- Tasks come from a fixed set of kinds:
  - `chat`: one turn of the conversation on Landed's Agent page. Once your direction is clear, the agent proposes a search brief, which Landed shows as a card.
  - `job_search`: after you confirm a brief, the agent searches the web for open postings that match it. It returns them as schema-checked JSON, and they land in your Leads column.
  - `email_check`: only offered if your agent can read email, and only once you turn on email watching in Landed. To give Claude Code email access, connect Gmail in Claude (claude.ai → Settings → Connectors). The daemon allows only the mailbox's read tools, never send, draft, label or delete.
  - `portal_check`: when an application has gone quiet for 3 weeks and you click "Look at its portal" in Landed, the agent opens its candidate portal (Workday, LinkedIn, Handshake, …) in your Chrome through Claude in Chrome and reads the status. It is read-only by construction: it gets the tools to open tabs, navigate and read pages, and no tool to click, type, fill forms, run scripts or read network traffic. It never signs in; a portal behind a login comes back as "needs you to sign in". Tip: connect Claude in Chrome in a Chrome profile that is only signed in to job sites.

  - `resume_parse`: reads a resume you uploaded in Landed. PDFs and images are saved to a temporary folder in `~/.landed/workspace/uploads`. The agent may read that one file and nothing else, and the folder is deleted when it's done.
  - `resume_merge` / `resume_tailor`: My Resume. These merge your uploaded resumes into one master resume, keeping every phrasing of every bullet, and tailor versions from it for a role. Both are text work only, with no tools or connectors; tailoring may read the job posting when it only has a link.

  - `automation_sync`: Landed's Automation page. The daemon keeps the schedule you set (email checks, job searches) in `~/.landed/automations.json` and runs it itself, so it works even when Landed is closed. Results wait there until Landed is open again and has stored them.

  The daemon re-checks what your agent can do (mail connector, Chrome) every 30 minutes, so connecting Gmail or Chrome needs no restart. claude.ai connectors don't always load in `claude -p`, so the last good mailbox lookup is kept in `~/.landed/capabilities.json`. An email or portal check that never reached the mailbox or Chrome reports an error and doesn't count as a check, so no email is skipped. `pnpm landed status` shows what was found. After updating Landed itself, restart the daemon (`pnpm landed start`) to pick up new code.
- Your message reaches the agent on stdin and never passes through a shell.
- The agent runs in an empty `~/.landed/workspace`. It ignores your own Claude Code settings and hooks (`--setting-sources ""`).
- Chat and search only get read-only web tools (WebSearch, WebFetch), and none of your MCP connectors load. Email checks only get your mailbox's read tools. Portal checks only get Chrome's open-tab, navigate and read tools, with no other connector loaded. The agent never gets file access or a shell.

`~/.landed/config.json` holds the server URL and this computer's key (mode 600). `LANDED_HOME` moves the whole folder somewhere else.
