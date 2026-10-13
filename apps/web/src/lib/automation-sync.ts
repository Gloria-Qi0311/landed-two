// The browser's half of Automation (packages/schema/src/automation.ts): send
// the schedule and the context the tasks need to the user's computer(s),
// and store what finished runs found — through the same processor rules as
// any other agent report — then ack it so the computer can drop it.
//
// One computer runs the schedule (the "designated" one): the first online
// one whose agent can read mail when email checks are on, else the first
// that can sync. Every online computer gets the settings, so a computer
// that used to run the schedule stops.
import { create } from 'zustand'
import type { Settings } from '@landed/observation-processor'
import type { AutomationKind, Automations, SyncInput, SyncOutput } from '@landed/schema/automation'
import type { EmailFinding } from '@landed/schema/email-check'
import type { FoundJob } from '@landed/schema/search-brief'
import { ingestEmailFindings, ingestFoundJobs } from './inbox'
import type { DataStore } from './store/types'
import { canRun, followJob, startJob, type Runtime, type RuntimeAgent } from '../hooks/runtimes'

export type SyncTarget = { runtime: Runtime; agent: RuntimeAgent }

/** What storing a result did, for the run list ("2 updated, 1 needs you"). */
export type Stored = { kind: AutomationKind; text: string }

type State = {
  output: SyncOutput | null
  designated: SyncTarget | null
  synced_at: string | null
  syncing: boolean
  error: string | null
  /** run ids → what storing their results did */
  stored: Record<string, Stored>
  /** kinds the user asked to run now, until a sync delivers the request */
  runNow: AutomationKind[]
}

type Env = {
  store: DataStore
  runtimes: Runtime[]
  automations: Automations
  settings: Settings
  /** applications, where email reading left off, the active search */
  context: () => Promise<SyncInput['context']>
  /** a result was stored: remember the email check's progress, refresh views */
  onStored: (kind: AutomationKind, startedAt: string) => Promise<void>
}

export function syncTargets(runtimes: Runtime[]): SyncTarget[] {
  return runtimes
    .filter((r) => r.online && !r.revoked_at)
    .flatMap((runtime) => {
      const agent = runtime.agents.find((a) => canRun(a, 'automation_sync'))
      return agent ? [{ runtime, agent }] : []
    })
}

export function designate(targets: SyncTarget[], automations: Automations): SyncTarget | null {
  if (automations.email_check.enabled) {
    const withMail = targets.find((t) => canRun(t.agent, 'email_check'))
    if (withMail) return withMail
  }
  return targets[0] ?? null
}

let acks: string[] = []
let inFlight: Promise<void> | null = null

const SYNC_TIMEOUT_MS = 30_000

function syncOne(target: SyncTarget, input: SyncInput): Promise<SyncOutput | null> {
  return new Promise((resolve, reject) => {
    let stop = () => {}
    const timer = setTimeout(() => { stop(); reject(new Error(`${target.runtime.name} didn't answer.`)) }, SYNC_TIMEOUT_MS)
    startJob(target.runtime.id, target.agent.id, 'automation_sync', input).then((jobId) => {
      stop = followJob(jobId, (e) => {
        if (e.type === 'done') { clearTimeout(timer); resolve((e.output as SyncOutput | undefined) ?? null) }
        if (e.type === 'error') { clearTimeout(timer); reject(new Error(e.message)) }
      })
    }, (e) => { clearTimeout(timer); reject(e) })
  })
}

export const useAutomationSync = create<State>(() => ({
  output: null, designated: null, synced_at: null, syncing: false, error: null, stored: {}, runNow: [],
}))

export function requestRunNow(kind: AutomationKind) {
  useAutomationSync.setState((s) => ({ runNow: [...new Set([...s.runNow, kind])] }))
}

/** One round: settings + context out (to every online computer), results in. */
export async function syncAutomations(env: Env): Promise<void> {
  if (inFlight) return inFlight
  inFlight = (async () => {
    const targets = syncTargets(env.runtimes)
    const designated = designate(targets, env.automations)
    useAutomationSync.setState({ designated, syncing: true })
    if (!designated) {
      useAutomationSync.setState({ syncing: false })
      return
    }
    try {
      const context = await env.context()
      const runNow = useAutomationSync.getState().runNow
      const ack = acks
      let gotResults = false
      for (const target of targets) {
        const mine = target.runtime.id === designated.runtime.id
        const out = await syncOne(target, {
          runtime_id: designated.runtime.id, automations: env.automations, context,
          run_now: mine ? runNow : [], ack: mine ? ack : [],
        })
        if (!mine || !out) continue
        acks = acks.filter((id) => !ack.includes(id))
        useAutomationSync.setState((s) => ({ runNow: s.runNow.filter((k) => !runNow.includes(k)) }))
        for (const result of out.results) {
          const stored = await storeResult(env, target, result)
          if (stored) {
            acks.push(result.id)
            gotResults = true
            useAutomationSync.setState((s) => ({ stored: { ...s.stored, [result.id]: stored } }))
          }
        }
        useAutomationSync.setState({ output: out })
      }
      useAutomationSync.setState({ synced_at: new Date().toISOString(), error: null })
      // Ack right away, so the computer can drop what's stored.
      if (gotResults) {
        inFlight = null
        await syncAutomations(env)
      }
    } catch (e) {
      useAutomationSync.setState({ error: (e as Error).message })
    } finally {
      useAutomationSync.setState({ syncing: false })
    }
  })().finally(() => { inFlight = null })
  return inFlight
}

async function storeResult(env: Env, target: SyncTarget, result: SyncOutput['results'][number]): Promise<Stored | null> {
  try {
    if (result.kind === 'email_check' && result.findings) {
      const r = await ingestEmailFindings(env.store, result.findings as EmailFinding[], {
        run_id: result.id, runtime_id: target.runtime.id, agent: target.agent.id, mail: target.agent.mail ?? 'email',
      }, env.settings)
      await env.onStored('email_check', result.started_at)
      const parts = [r.updated && `${r.updated} updated`, r.added && `${r.added} added`, r.needs_input && `${r.needs_input} need${r.needs_input === 1 ? 's' : ''} you`].filter(Boolean)
      return { kind: 'email_check', text: parts.length ? parts.join(', ') : 'nothing new' }
    }
    if (result.kind === 'job_search' && result.jobs) {
      const r = await ingestFoundJobs(env.store, result.jobs as FoundJob[], { run_id: result.id, runtime_id: target.runtime.id, agent: target.agent.id })
      const search = (await env.store.listJobSearches()).find((s) => s.status === 'active')
      if (search) {
        await env.store.updateJobSearch(search.id, {
          last_run_at: result.finished_at,
          last_run_result: { ...r, agents: [`${target.agent.label} on ${target.runtime.name}`] },
        })
      }
      await env.onStored('job_search', result.started_at)
      return { kind: 'job_search', text: `${r.added} new in Leads${r.merged ? `, ${r.merged} already there` : ''}` }
    }
  } catch (e) {
    console.warn('[landed] storing an automation result failed', e)
  }
  return null
}
