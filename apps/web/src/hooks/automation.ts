// Automation (lib/automation-sync.ts): the account's schedule (/me), and the
// app-level runner that keeps the user's computer in sync — on load, every
// few minutes (every 20 seconds while something runs), and right after the
// user changes a schedule or asks to run something now.
import { useEffect, useRef } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { parseAutomations, type AutomationKind, type Automations } from '@landed/schema/automation'
import { api } from '../lib/api'
import { syncAutomations, useAutomationSync } from '../lib/automation-sync'
import { useStore, type DataStore } from '../lib/store'
import { useAccountPrefs, type Me } from './inbox'
import { useRuntimes } from './runtimes'

const IDLE_MS = 5 * 60_000
const BUSY_MS = 20_000

export function useAutomations(): { automations: Automations; loaded: boolean } {
  const prefs = useAccountPrefs()
  return { automations: parseAutomations(prefs.data?.automations), loaded: !!prefs.data }
}

export function useSetAutomations() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (automations: Automations) => api.patch<Me>('/me', { automations }),
    onSuccess: (me) => qc.setQueryData(['profile', 'me'], me),
  })
}

async function context(store: DataStore, emailSince: string | null) {
  const [apps, companies, searches] = await Promise.all([store.listApplications(), store.listCompanies(), store.listJobSearches()])
  const name = new Map(companies.map((c) => [c.id, c.name]))
  const active = searches.find((s) => s.status === 'active')
  return {
    applications: apps.slice(0, 300).map((a) => ({ company: name.get(a.company_id) ?? '', role: a.role, stage: a.stage })).filter((a) => a.company),
    email_since: emailSince,
    brief: active?.brief ?? null,
    search_id: active?.id ?? null,
  }
}

/** Mount once below the login gate. */
export function useAutomationRunner() {
  const qc = useQueryClient()
  const { store, ready } = useStore()
  const prefs = useAccountPrefs().data
  const runtimes = useRuntimes().data
  const automations = parseAutomations(prefs?.automations)
  const runNow = useAutomationSync((s) => s.runNow)
  const running = useAutomationSync((s) => Object.values(s.output?.state ?? {}).some((x) => x?.running))
  const env = useRef<Parameters<typeof syncAutomations>[0] | null>(null)

  env.current = ready && prefs && runtimes ? {
    store, runtimes, automations,
    settings: { autoApply: prefs.auto_apply_updates ?? true },
    context: () => context(store, prefs.email_checked_at ?? null),
    onStored: async (kind: AutomationKind, startedAt: string) => {
      if (kind === 'email_check' && (!prefs.email_checked_at || startedAt > prefs.email_checked_at)) {
        qc.setQueryData(['profile', 'me'], await api.patch<Me>('/me', { email_checked_at: startedAt }))
      }
      for (const key of ['applications', 'suggestions', 'job_leads', 'job_searches', 'companies', 'portal_events']) qc.invalidateQueries({ queryKey: [key] })
    },
  } : null

  const settingsKey = JSON.stringify(automations)
  const onlineKey = (runtimes ?? []).filter((r) => r.online).map((r) => r.id).join()
  useEffect(() => {
    if (env.current) void syncAutomations(env.current)
  }, [ready, !!prefs, settingsKey, onlineKey, runNow.length]) // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    const timer = setInterval(() => { if (env.current) void syncAutomations(env.current) }, running || runNow.length ? BUSY_MS : IDLE_MS)
    return () => clearInterval(timer)
  }, [running, runNow.length])
}
