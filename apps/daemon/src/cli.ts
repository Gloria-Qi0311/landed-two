#!/usr/bin/env node
// landed — connect this computer to Landed and run its tasks with the agent
// CLIs installed here: Claude Code, Codex, and any agent that speaks ACP
// (Gemini CLI, GitHub Copilot CLI, Cursor, Goose, OpenCode, Qwen Code…).
//
// Most people never type these: Landed.app (scripts/build-mac.mjs) runs
// `setup` when opened and `open-url` when Landed's "Connect this computer"
// opens a landed:// link, and the background service runs `service`.
//
//   landed setup          # install the background service (macOS)
//   landed open-url <url> # pair from a landed://connect link (asks first)
//   landed service        # what the background service runs
//   landed uninstall      # remove the background service
//   landed connect --server https://landed.example.com --token landed_rt_…
//   landed start          # reconnect with the saved config, in this terminal
//   landed status         # what's configured and which agents were found
//
// From the Landed repo: `pnpm landed <command>`.
import { hostname } from 'node:os'
import { join } from 'node:path'
import { parseArgs } from 'node:util'
import { agentForKind, detectAgents, detectionNotes, runTask, type AgentInfo, type Task } from './agents.ts'
import { handleSync, setupAutomations, tick } from './automations.ts'
import type { SyncInput } from '@landed/schema/automation'
import { clearConfig, home, loadConfig, saveConfig, type Config } from './config.ts'
import {
  computerName, confirm, installService, notify, otherDaemon, parseConnectUrl, restartService, serviceInstalled, takeLock,
  uninstallService,
} from './mac.ts'
import { AuthError, createEventSink, LandedClient } from './connection.ts'

const VERSION = '0.7.0'
const MAX_PARALLEL = 2

const describe = (agents: AgentInfo[]) =>
  agents.map((a) => `${a.label} ${a.version ?? ''}${a.mail ? `, reads ${a.mail}` : ''}${a.browser ? `, uses ${a.browser}` : ''}`.trim()).join(', ')

function log(msg: string) {
  console.log(`[landed ${new Date().toLocaleTimeString()}] ${msg}`)
}

const REDETECT_MS = 30 * 60_000

/** Connect and work until the computer is removed in Landed ('revoked');
 *  in a terminal that exits, as a service it waits for a new pairing. */
async function run(config: Config, opts: { service?: boolean } = {}): Promise<'revoked' | 'no-agent'> {
  let agents = await detectAgents({ quick: true })
  if (agents.length === 0) {
    log('No supported agent found. Install and sign in to Claude Code (https://claude.com/claude-code), Codex, Gemini CLI or another ACP agent, then run `landed start` again.')
    if (!opts.service) process.exit(1)
    return 'no-agent'
  }
  const client = new LandedClient(config.server, config.token)
  const name = config.name ?? hostname().replace(/\.local$/, '')
  let running = 0
  const waiting: Task[] = []

  const work = (task: Task) => {
    // Settings in, finished results out — no agent run, so not queued.
    if (task.kind === 'automation_sync') {
      const sink = createEventSink(client, task.id)
      sink.emit({ type: 'done', text: '', output: handleSync(task.input as SyncInput) })
      void sink.flush()
      return
    }
    if (running >= MAX_PARALLEL) return void waiting.push(task)
    running++
    log(`task ${task.id.slice(0, 8)}: ${task.kind} with ${task.agent}`)
    const sink = createEventSink(client, task.id)
    runTask(task, (e) => sink.emit(e))
      .then(() => sink.flush())
      .catch((err) => log(`task ${task.id.slice(0, 8)} failed: ${err}`))
      .finally(() => {
        running--
        const next = waiting.shift()
        if (next) work(next)
      })
  }

  // Full detection (mailbox lookup) in the background, then every 30
  // minutes: connectors come and go, and claude.ai's load unreliably.
  let lastNotes = ''
  const redetect = async () => {
    try {
      const next = await detectAgents()
      if (detectionNotes.join() !== lastNotes) {
        lastNotes = detectionNotes.join()
        for (const note of detectionNotes) log(note)
      }
      if (JSON.stringify(next) !== JSON.stringify(agents)) {
        agents = next
        await client.hello({ name, agents, daemon_version: VERSION })
        log(`agents updated: ${describe(agents)}`)
      }
    } catch (err) {
      log(`couldn't refresh what the agents can do (${(err as Error).message})`)
    }
  }
  void redetect()
  const timers = [
    setInterval(redetect, REDETECT_MS),
    // Scheduled work (Automation page): check every minute what's due.
    setInterval(tick, 60_000),
  ]
  timers.forEach((t) => t.unref())

  let backoff = 1000
  for (;;) {
    try {
      const me = await client.hello({ name, agents, daemon_version: VERSION }) as { id: string }
      // Which computer this is: the browser names the one that runs the schedule.
      setupAutomations({ runtimeId: me.id, runTask, log, pickAgent: (kind) => agentForKind(agents, kind) })
      await client.stream(work, () => {
        backoff = 1000
        log(`connected to ${config.server} as "${name}" — agents: ${describe(agents)}`)
      })
      log('connection closed, reconnecting…')
    } catch (err) {
      if (err instanceof AuthError) {
        log(`${err.message}: in Landed open Agent → Connect this computer.`)
        if (!opts.service) process.exit(2)
        timers.forEach(clearInterval)
        return 'revoked'
      }
      log(`can't reach Landed (${(err as Error).message}); retrying in ${Math.round(backoff / 1000)}s`)
    }
    await new Promise((r) => setTimeout(r, backoff))
    backoff = Math.min(backoff * 2, 60_000)
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

/** One daemon per computer: in a terminal, step aside for a running one. */
function exclusive() {
  const other = otherDaemon()
  if (other) {
    console.error(`Landed is already running on this computer (pid ${other}${serviceInstalled() ? ', the background service' : ''}). Nothing to do.`)
    process.exit(0)
  }
  takeLock()
}

/** The background service: wait for a pairing, run, and if the computer is
 *  removed in Landed, forget the connection and wait for the next one. */
async function service() {
  while (otherDaemon()) await sleep(10_000) // e.g. a terminal daemon still running
  takeLock()
  log(`Landed ${VERSION} service started`)
  for (;;) {
    const config = loadConfig()
    if (!config) {
      await sleep(3000)
      continue
    }
    const outcome = await run(config, { service: true })
    if (outcome === 'revoked') {
      clearConfig()
      log('this computer was removed in Landed; waiting for a new connection')
    } else {
      await sleep(60_000) // no agent installed yet: look again in a minute
    }
  }
}

/** landed://connect?… from Landed's "Connect this computer": ask, save, restart the service. */
async function openUrl(raw: string | undefined) {
  const link = raw ? parseConnectUrl(raw) : null
  if (!link) {
    console.error("That isn't a Landed connect link.")
    process.exit(1)
  }
  const current = loadConfig()
  const host = new URL(link.server).host
  const message = current && current.server !== link.server
    ? `Connect this Mac to Landed at ${host}?\n\nIt's connected to ${new URL(current.server).host} now; that connection will be replaced.`
    : `Connect this Mac to Landed at ${host}?\n\nLanded's tasks will run here with your own agent (Claude Code), on your own subscription.`
  if (!confirm(message)) process.exit(0)
  saveConfig({ server: link.server, token: link.token, name: link.name ?? computerName() ?? undefined })
  if (!serviceInstalled()) installService()
  else restartService()
  notify(`This Mac is connected to Landed at ${host}.`)
}

async function main() {
  const { positionals, values } = parseArgs({
    allowPositionals: true,
    options: { server: { type: 'string' }, token: { type: 'string' }, name: { type: 'string' } },
  })
  const command = positionals[0] ?? 'start'

  if (command === 'connect') {
    if (!values.server || !values.token?.startsWith('landed_rt_')) {
      console.error('Usage: landed connect --server <Landed URL> --token <landed_rt_… from Landed → Agent> [--name <this computer>]')
      process.exit(1)
    }
    const config: Config = { server: values.server, token: values.token, ...(values.name ? { name: values.name } : {}) }
    saveConfig(config)
    log(`saved ${join(home(), 'config.json')}`)
    if (serviceInstalled()) {
      restartService()
      log('the background service picked up the new connection')
      return
    }
    exclusive()
    return void (await run(config))
  }

  if (command === 'start') {
    const config = loadConfig()
    if (!config) {
      console.error(
        `Not paired yet — this computer has no saved connection (${join(home(), 'config.json')}).\n` +
          'In Landed open Agent → Connect this computer, then run the `pnpm landed connect …` command it shows.\n' +
          'After that, `pnpm landed start` reconnects.',
      )
      process.exit(1)
    }
    exclusive()
    return void (await run(config))
  }

  if (command === 'service') return service()

  if (command === 'setup') {
    if (process.platform !== 'darwin') {
      console.error('The background service is macOS-only for now; use `landed start`.')
      process.exit(1)
    }
    const { plist } = installService()
    log(`background service installed (${plist}); it starts at login and restarts if it stops`)
    notify(loadConfig() ? 'Landed is running in the background.' : 'Landed is installed. In Landed, click "Connect this computer".')
    return
  }

  if (command === 'open-url') return openUrl(positionals[1])

  if (command === 'uninstall') {
    uninstallService()
    log('background service removed')
    return
  }

  if (command === 'status') {
    const config = loadConfig()
    console.log(config ? `Paired with ${config.server}${config.name ? ` as "${config.name}"` : ''}` : 'Not paired.')
    const agents = await detectAgents()
    console.log(agents.length ? `Agents: ${agents.map((a) => `${a.label} (${a.version})`).join(', ')}` : 'No supported agents found.')
    for (const note of detectionNotes) console.log(note)
    for (const a of agents.filter((x) => x.id === 'claude')) {
      console.log(a.mail
        ? `${a.label} can read your ${a.mail} (read-only), so Landed can check your email for application updates.`
        : `${a.label} has no mail connector, so email checks are off. To turn them on, connect Gmail in Claude (claude.ai → Settings → Connectors); a running daemon picks it up within 30 minutes.`)
      console.log(a.browser
        ? `${a.label} can look at candidate portals in ${a.browser} (read-only: it can navigate and read, never click or type).`
        : `${a.label} can't reach Chrome, so portal checks are off. Open Chrome with the Claude in Chrome extension connected; a running daemon picks it up within 30 minutes.`)
    }
    return
  }

  console.error(`Unknown command "${command}". Commands: setup, open-url, service, uninstall, connect, start, status.`)
  process.exit(1)
}

void main()
