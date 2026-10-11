#!/usr/bin/env node
// landed — connect this computer to Landed and run its tasks with the agent
// CLIs installed here (Claude Code today; Codex and Gemini CLI next).
//
//   landed connect --server https://landed.example.com --token landed_rt_…
//   landed start        # reconnect with the saved config
//   landed status       # what's configured and which agents were found
//
// From the Landed repo: `pnpm landed <command>`.
import { hostname } from 'node:os'
import { join } from 'node:path'
import { parseArgs } from 'node:util'
import { detectAgents, runTask, type Task } from './agents.ts'
import { home, loadConfig, saveConfig, type Config } from './config.ts'
import { AuthError, createEventSink, LandedClient } from './connection.ts'

const VERSION = '0.1.0'
const MAX_PARALLEL = 2

function log(msg: string) {
  console.log(`[landed ${new Date().toLocaleTimeString()}] ${msg}`)
}

async function run(config: Config) {
  const agents = detectAgents()
  if (agents.length === 0) {
    log('No supported agent found. Install Claude Code (https://claude.com/claude-code) and sign in, then run `landed start` again.')
    process.exit(1)
  }
  const client = new LandedClient(config.server, config.token)
  const name = config.name ?? hostname().replace(/\.local$/, '')
  let running = 0
  const waiting: Task[] = []

  const work = (task: Task) => {
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

  let backoff = 1000
  for (;;) {
    try {
      await client.hello({ name, agents, daemon_version: VERSION })
      await client.stream(work, () => {
        backoff = 1000
        log(`connected to ${config.server} as "${name}" — agents: ${agents.map((a) => `${a.label} ${a.version ?? ''}`.trim()).join(', ')}`)
      })
      log('connection closed, reconnecting…')
    } catch (err) {
      if (err instanceof AuthError) {
        log(`${err.message}: in Landed open Applications → Ask Agent → Connect this computer, and run the new command.`)
        process.exit(2)
      }
      log(`can't reach Landed (${(err as Error).message}); retrying in ${Math.round(backoff / 1000)}s`)
    }
    await new Promise((r) => setTimeout(r, backoff))
    backoff = Math.min(backoff * 2, 60_000)
  }
}

async function main() {
  const { positionals, values } = parseArgs({
    allowPositionals: true,
    options: { server: { type: 'string' }, token: { type: 'string' }, name: { type: 'string' } },
  })
  const command = positionals[0] ?? 'start'

  if (command === 'connect') {
    if (!values.server || !values.token?.startsWith('landed_rt_')) {
      console.error('Usage: landed connect --server <Landed URL> --token <landed_rt_… from Landed → Applications → Ask Agent> [--name <this computer>]')
      process.exit(1)
    }
    const config: Config = { server: values.server, token: values.token, ...(values.name ? { name: values.name } : {}) }
    saveConfig(config)
    log(`saved ${join(home(), 'config.json')}`)
    return run(config)
  }

  if (command === 'start') {
    const config = loadConfig()
    if (!config) {
      console.error(
        `Not paired yet — this computer has no saved connection (${join(home(), 'config.json')}).\n` +
          'In Landed open Applications → Ask Agent → Connect this computer, then run the `pnpm landed connect …` command it shows.\n' +
          'After that, `pnpm landed start` reconnects.',
      )
      process.exit(1)
    }
    return run(config)
  }

  if (command === 'status') {
    const config = loadConfig()
    console.log(config ? `Paired with ${config.server}${config.name ? ` as "${config.name}"` : ''}` : 'Not paired.')
    const agents = detectAgents()
    console.log(agents.length ? `Agents: ${agents.map((a) => `${a.label} (${a.version})`).join(', ')}` : 'No supported agents found.')
    return
  }

  console.error(`Unknown command "${command}". Commands: connect, start, status.`)
  process.exit(1)
}

void main()
