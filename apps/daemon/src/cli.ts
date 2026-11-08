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
//   landed fill-trace <ref> [--json]  # what one autofill did (the ref its popup showed)
//   landed native-host    # Chrome Native Messaging (started by Chrome)
//
// From the Landed repo: `pnpm landed <command>`.
import { hostname } from 'node:os'
import { join } from 'node:path'
import { parseArgs } from 'node:util'
import { agentForKind, detectAgents, detectionNotes, mailStatus, runTask, type AgentInfo, type Task } from './agents.ts'
import { handleSync, setupAutomations, tick } from './automations.ts'
import { connectCodex, existingLandedUrl, findCodex } from './codex-connector.ts'
import { connectGemini, existingGeminiLandedUrl, findGemini, openGeminiForAuth } from './gemini-connector.ts'
import type { SyncInput } from '@landed/schema/automation'
import { formatFillTrace, normalizeFillTraceRef, parseFillTrace } from '@landed/schema/fill-trace'
import { clearConfig, home, loadConfig, saveConfig, type Config } from './config.ts'
import {
  alert, computerName, confirm, installService, notify, otherDaemon, parseAgentConnectUrl, parseConnectUrl, restartService, serviceInstalled, takeLock,
  uninstallService,
} from './mac.ts'
import { AuthError, createEventSink, LandedClient } from './connection.ts'
import { runNativeHost } from './native-host.ts'
import { startUpdater } from './updater.ts'
import { startSafariBridgeServer } from './safari-bridge.ts'

const VERSION = '0.10.0'
const MAX_PARALLEL = 2

const describe = (agents: AgentInfo[]) =>
  agents.map((a) => `${a.label} ${a.version ?? ''}${a.mail ? `, reads ${a.mail}` : ''}`.trim()).join(', ')

function log(msg: string) {
  console.log(`[landed ${new Date().toLocaleTimeString()}] ${msg}`)
}

const REDETECT_MS = 30 * 60_000
/** While a mailbox is connected but not usable yet, look again this soon. */
const CONFIRM_RETRY_MS = 2 * 60_000

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
  // minutes: connectors come and go. Also right away when a page waiting
  // for a connector asks (sync `recheck`), and again soon while a connected
  // mailbox isn't usable yet. One at a time.
  let lastNotes = ''
  let detecting: Promise<void> | null = null
  let checkedAt: string | null = null
  let confirmRetry: ReturnType<typeof setTimeout> | null = null
  const redetect = (): Promise<void> => (detecting ??= (async () => {
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
    } finally {
      checkedAt = new Date().toISOString()
      detecting = null
      if (mailStatus === 'confirming' && !confirmRetry) {
        confirmRetry = setTimeout(() => { confirmRetry = null; void redetect() }, CONFIRM_RETRY_MS)
        confirmRetry.unref()
      }
    }
  })())
  void redetect()
  const timers = [
    setInterval(redetect, REDETECT_MS),
    // Scheduled work (Workflow page): check every minute what's due.
    setInterval(tick, 60_000),
  ]
  timers.forEach((t) => t.unref())

  let backoff = 1000
  for (;;) {
    try {
      const me = await client.hello({ name, agents, daemon_version: VERSION }) as { id: string }
      // Which computer this is: the browser names the one that runs the schedule.
      setupAutomations({
        runtimeId: me.id, runTask, log,
        recheck: () => void redetect(),
        abilities: () => ({ mail: mailStatus, checking: detecting !== null, checked_at: checkedAt }),
        pickAgent: (kind) => agentForKind(agents, kind),
        agentsFor: (kind) => agents.filter((a) => a.kinds.includes(kind)).map((a) => ({ id: a.id, label: a.label })),
      })
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
  await startSafariBridgeServer(log)
  startUpdater(() => loadConfig()?.server ?? null, log)
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

/** A confirmed action from Landed's web UI: pair this computer, or add Landed
 * to a local agent. The custom-scheme payload is validated before either. */
async function openUrl(raw: string | undefined) {
  const agentLink = raw ? parseAgentConnectUrl(raw) : null
  if (agentLink?.agent === 'codex') {
    const executable = findCodex()
    if (!executable) {
      alert("Codex isn't installed on this Mac yet. Install or open Codex, then click Connect Codex in Landed again.")
      process.exit(1)
    }
    const current = existingLandedUrl(executable)
    const host = new URL(agentLink.url).host
    const replacing = current && current !== agentLink.url
    const message = replacing
      ? `Connect Codex to Landed at ${host}?\n\nThis replaces Codex's Landed connector for ${new URL(current).host}, then opens your browser so you can approve access.`
      : `Connect Codex to Landed at ${host}?\n\nLanded will add the connector for you, then open your browser so you can approve access.`
    if (!confirm(message, 'Connect Codex')) process.exit(0)
    const result = connectCodex(executable, agentLink.url)
    if (!result.ok) {
      alert(`${result.error}\n\nTry Connect Codex in Landed again.`)
      process.exit(1)
    }
    notify('Codex is connected to Landed. New Codex tasks can now use it.')
    return
  }
  if (agentLink?.agent === 'gemini') {
    const executable = findGemini()
    if (!executable) {
      alert("Gemini CLI isn't installed on this Mac yet. Install Gemini CLI, then click Connect Gemini CLI in Landed again.")
      process.exit(1)
    }
    let current: string | null
    try {
      current = existingGeminiLandedUrl()
    } catch (error) {
      alert(`${error instanceof Error ? error.message : 'Gemini settings could not be read.'}\n\nFix Gemini CLI settings, then try Connect Gemini CLI in Landed again.`)
      process.exit(1)
    }
    const host = new URL(agentLink.url).host
    const replacing = current && current !== agentLink.url
    const previousHost = current ? new URL(current).host : null
    const message = replacing
      ? `Connect Gemini CLI to Landed at ${host}?\n\nThis replaces Gemini CLI's Landed connector for ${previousHost}, then opens Gemini CLI and your browser so you can approve access.`
      : `Connect Gemini CLI to Landed at ${host}?\n\nLanded will add the connector, then open Gemini CLI and your browser so you can approve access.`
    if (!confirm(message, 'Connect Gemini CLI')) process.exit(0)
    const result = connectGemini(executable, agentLink.url)
    if (!result.ok) {
      alert(`${result.error}\n\nTry Connect Gemini CLI in Landed again.`)
      process.exit(1)
    }
    const openError = openGeminiForAuth(executable)
    if (openError) {
      alert(`Gemini CLI is configured, but Landed couldn't open Terminal: ${openError}\n\nOpen Gemini CLI yourself to finish signing in.`)
      process.exit(1)
    }
    notify('Gemini CLI is opening. Approve Landed in the browser to finish connecting it.')
    return
  }

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

/** `landed fill-trace <ref>`: one of the owner's fill traces, read with this
 *  computer's pairing (Cloud accounts keep them 30 days). */
async function printFillTrace(raw: string | undefined, json: boolean) {
  const ref = normalizeFillTraceRef(raw)
  if (!ref) {
    console.error('Usage: landed fill-trace <ref> [--json] — the 6-character ref the extension showed after a fill')
    process.exit(1)
  }
  const config = loadConfig()
  if (!config) {
    console.error('Not paired yet: this computer reads fill traces with its Landed connection.')
    process.exit(1)
  }
  const trace = parseFillTrace(await new LandedClient(config.server, config.token).fillTrace(ref))
  if (!trace) {
    console.error(`No fill trace ${ref}. Only accounts with Landed Cloud sync on keep them on the server (30 days); others are in the extension.`)
    process.exit(1)
  }
  console.log(json ? JSON.stringify(trace, null, 2) : formatFillTrace(trace))
}

async function main() {
  const { positionals, values } = parseArgs({
    allowPositionals: true,
    options: { server: { type: 'string' }, token: { type: 'string' }, name: { type: 'string' }, json: { type: 'boolean' } },
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

  if (command === 'native-host') return runNativeHost()

  if (command === 'setup') {
    if (process.platform !== 'darwin') {
      console.error('The background service is macOS-only for now; use `landed start`.')
      process.exit(1)
    }
    const { plist, nativeHosts, extension } = installService()
    log(`background service installed (${plist}); it starts at login and restarts if it stops`)
    log(`Apply Assist extension registered for ${nativeHosts.length} Chromium browsers`)
    if (extension) log(`Chromium extension ready at ${extension}`)
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
        : `${a.label} has no mail connector, so email checks are off. To turn them on, connect Gmail in Claude (claude.ai → Settings → Connectors), then open Landed: it checks again right away.`)
    }
    return
  }

  if (command === 'fill-trace') return printFillTrace(positionals[1], values.json === true)

  console.error(`Unknown command "${command}". Commands: setup, open-url, service, native-host, uninstall, connect, start, status, fill-trace.`)
  process.exit(1)
}

void main()
