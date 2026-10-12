# @landed/daemon

The Landed daemon connects your computer to Landed and runs Landed's AI tasks with the agent CLIs you already have installed. It works the same way as [Multica](https://github.com/multica-ai/multica):

- The tasks use your own subscription (Claude Pro or Max, ChatGPT Plus, …), so neither you nor Landed pays for API usage.
- Your computer does the work. The Landed server only relays tasks and their output, held in memory and never stored.

**Supported agents:** Claude Code. Codex and Gemini CLI are next.

## Use it

1. In Landed, open **Applications → Ask Agent → Connect this computer** and copy the command.
2. Run it in a terminal on that computer, from the Landed repo folder:

   ```sh
   pnpm landed connect --server https://your-landed --token landed_rt_…   # pair + run
   pnpm landed start                                                       # later: run again
   pnpm landed status                                                      # what's paired, which agents were found
   ```

You need Node 23.6+ and at least one supported agent CLI, installed and signed in. Keep the daemon running for Landed to reach the agents; your Mac mini is a good always-on host. Removing the computer in Landed revokes its key, and the daemon exits.

## What an agent can do here

- Tasks come from a fixed set of kinds:
  - `chat`: one Ask Agent turn. Once your direction is clear, the agent proposes a search brief, which Landed shows as a card.
  - `job_search`: after you confirm a brief, the agent searches the web for open postings that match it. It returns them as schema-checked JSON, and they land in your Leads column.

  Status checks come next. After updating Landed, restart the daemon (`pnpm landed start`) so it picks up new task kinds.
- Your message reaches the agent on stdin and never passes through a shell.
- The agent runs in an empty `~/.landed/workspace`. It ignores your own Claude Code settings and hooks (`--setting-sources ""`).
- It only gets read-only web tools (WebSearch, WebFetch). It has no file access and no shell.

`~/.landed/config.json` holds the server URL and this computer's key (mode 600). `LANDED_HOME` moves the whole folder somewhere else.
