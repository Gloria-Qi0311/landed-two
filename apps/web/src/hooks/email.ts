// Email watching: off until the user turns it on (account-level, /me), then
// the user's own agent checks their mailbox every few hours while Landed is
// open, plus "Check now". Runs only on a computer whose agent can read mail
// (a mail connector, e.g. Gmail in Claude Code); see lib/email-check.ts.
import { useEffect, useRef } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { api } from '../lib/api'
import { useAuth } from '../lib/auth'
import { useEmailCheck, type EmailTarget } from '../lib/email-check'
import { useStore, type DataStore } from '../lib/store'
import { useAccountPrefs, type Me } from './inbox'
import { canRun, useRuntimes, type Runtime } from './runtimes'

const CHECK_EVERY_MS = 4 * 3_600_000
const TICK_MS = 5 * 60_000
const RETRY_MS = 30 * 60_000
const FIRST_LOOKBACK_DAYS = 30
/** Re-read a little before the last check so nothing slips between checks;
 *  emails already seen dedupe on their message id. */
const OVERLAP_MS = 3_600_000

/** The agent that will read mail: the first online one that can. */
export function emailTarget(runtimes: Runtime[] | undefined): EmailTarget | null {
  for (const runtime of runtimes ?? []) {
    if (!runtime.online || runtime.revoked_at) continue
    const agent = runtime.agents.find((a) => canRun(a, 'email_check'))
    if (agent) return { runtime, agent }
  }
  return null
}

export function useSetEmailWatch() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (on: boolean) => api.patch<Me>('/me', { email_watch: on }),
    onSuccess: (me) => qc.setQueryData(['profile', 'me'], me),
  })
}

async function checkInput(store: DataStore, checkedAt: string | null) {
  const [apps, companies] = await Promise.all([store.listApplications(), store.listCompanies()])
  const name = new Map(companies.map((c) => [c.id, c.name]))
  const since = checkedAt
    ? new Date(Date.parse(checkedAt) - OVERLAP_MS).toISOString()
    : new Date(Date.now() - FIRST_LOOKBACK_DAYS * 86_400_000).toISOString()
  return {
    since,
    applications: apps.slice(0, 300).map((a) => ({ company: name.get(a.company_id) ?? '', role: a.role, stage: a.stage })).filter((a) => a.company),
  }
}

/** "Check now" (also used by the schedule). */
export function useCheckEmail() {
  const { store } = useStore()
  const runtimes = useRuntimes()
  const prefs = useAccountPrefs()
  const target = emailTarget(runtimes.data)
  return {
    target,
    run: async () => {
      if (!target) return
      await useEmailCheck.getState().start(target, await checkInput(store, prefs.data?.email_checked_at ?? null))
    },
  }
}

/** Mount once below the login gate: binds the runner and checks on schedule. */
export function useEmailWatcher() {
  const qc = useQueryClient()
  const { store, ready } = useStore()
  const userId = useAuth((s) => s.user?.id)
  const prefs = useAccountPrefs().data
  const runtimes = useRuntimes().data
  const autoApply = useRef(true)
  autoApply.current = prefs?.auto_apply_updates ?? true

  useEffect(() => {
    if (!ready || !userId) return
    useEmailCheck.getState().bind(userId, {
      store,
      settings: () => ({ autoApply: autoApply.current }),
      onChecked: async (startedAt) => {
        const me = await api.patch<Me>('/me', { email_checked_at: startedAt })
        qc.setQueryData(['profile', 'me'], me)
      },
      onData: () => {
        for (const key of ['applications', 'suggestions', 'job_leads', 'companies', 'portal_events']) qc.invalidateQueries({ queryKey: [key] })
      },
    })
  }, [ready, userId, store, qc])

  const target = emailTarget(runtimes)
  const watch = !!prefs?.email_watch
  const checkedAt = prefs?.email_checked_at ?? null
  useEffect(() => {
    if (!ready || !watch || !target) return
    const tick = async () => {
      const { check } = useEmailCheck.getState()
      if (check?.status === 'running') return
      // Due every 4 hours since the last check that actually read mail; a
      // failed attempt (e.g. the connector didn't load) is retried sooner.
      if (checkedAt && Date.now() - Date.parse(checkedAt) < CHECK_EVERY_MS) return
      const attempt = check ? Date.now() - Date.parse(check.started_at) : Infinity
      if (attempt < (check?.status === 'error' ? RETRY_MS : CHECK_EVERY_MS)) return
      try {
        await useEmailCheck.getState().start(target, await checkInput(store, checkedAt))
      } catch (e) {
        console.warn('[landed] email check failed to start', e)
      }
    }
    void tick()
    const timer = setInterval(tick, TICK_MS)
    return () => clearInterval(timer)
  }, [ready, watch, target?.runtime.id, target?.agent.id, checkedAt, store]) // eslint-disable-line react-hooks/exhaustive-deps
}
