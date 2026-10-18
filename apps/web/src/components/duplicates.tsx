// "These look like the same application" — on the Agent page (with
// Landed's other questions) and in the chat when the user asks their agent
// to clean up duplicates (```landed-dedupe). One card per group: pick the
// one to keep (the furthest along by default) and merge, or say they're
// different. Rules: lib/duplicates.ts.
import { useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { Icon, stageColors } from './primitives'
import { STAGE_LABELS } from '../data'
import { dismissDuplicates, duplicateGroups, isDupQuestion, mergeApplications, pickPrimary } from '../lib/duplicates'
import { useStore, type DbApplication } from '../lib/store'
import { muted, danger } from './ui'

const card = {
  borderRadius: 12, background: 'var(--surface)', boxShadow: 'var(--shadow-sm)', padding: '12px 14px',
  display: 'flex', flexDirection: 'column', gap: 8,
} as const

type Group = { ids: string[]; apps: DbApplication[]; names: Map<string, string> }

/** The duplicate groups right now, with the rows to show. */
export function useDuplicates() {
  const { store, ready } = useStore()
  return useQuery({
    queryKey: ['applications', 'duplicates', store.kind],
    enabled: ready,
    queryFn: async (): Promise<Group[]> => {
      const [apps, companies, suggestions] = await Promise.all([store.listApplications(), store.listCompanies(), store.listSuggestions()])
      const dismissed = new Set(suggestions.filter(isDupQuestion).map((s) => s.dedupe_key))
      const names = new Map(companies.map((c) => [c.id, c.name]))
      return duplicateGroups(apps, companies, dismissed).map((ids) => ({ ids, apps: apps.filter((a) => ids.includes(a.id)), names }))
    },
  })
}

function StagePill({ stage }: { stage: string }) {
  const c = (stageColors as Record<string, { bg: string; fg: string; ring: string }>)[stage] ?? stageColors.saved
  return (
    <span style={{ fontSize: 10.5, fontWeight: 500, padding: '1px 7px', borderRadius: 999, background: c.bg, color: c.fg, border: `0.5px solid ${c.ring}`, whiteSpace: 'nowrap' }}>
      {(STAGE_LABELS as Record<string, string>)[stage] ?? (stage === 'saved' ? 'Lead' : stage)}
    </span>
  )
}

const day = (iso: string | null) => (iso ? new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric' }) : null)

function GroupCard({ group }: { group: Group }) {
  const { store } = useStore()
  const qc = useQueryClient()
  const [keep, setKeep] = useState(() => pickPrimary(group.apps).id)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const refresh = () => {
    for (const key of ['applications', 'suggestions', 'job_leads', 'companies']) qc.invalidateQueries({ queryKey: [key] })
  }
  const run = async (fn: () => Promise<unknown>) => {
    setBusy(true)
    setError(null)
    try {
      await fn()
      refresh()
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setBusy(false)
    }
  }
  const company = group.names.get(group.apps[0].company_id) ?? 'this company'

  return (
    <div style={card}>
      <div style={{ fontSize: 11, color: 'var(--fg-muted)', display: 'flex', alignItems: 'center', gap: 5 }}>
        <Icon name="sparkle" size={11} /> Landed asks · {group.apps.length === 2 ? 'these two look' : `these ${group.apps.length} look`} like the same application
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
        {group.apps.map((a) => (
          <label key={a.id} style={{ display: 'flex', gap: 8, alignItems: 'flex-start', cursor: 'pointer', fontSize: 12.5, lineHeight: 1.45 }}>
            <input type="radio" name={`keep-${group.ids.join('-')}`} checked={keep === a.id} onChange={() => setKeep(a.id)} style={{ marginTop: 3 }} />
            <span style={{ minWidth: 0 }}>
              <span style={{ display: 'inline-flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' }}>
                <b>{group.names.get(a.company_id)}</b> — {a.role} <StagePill stage={a.stage} />
                {keep === a.id && <span style={{ ...muted, fontSize: 10.5 }}>keep</span>}
              </span>
              <span style={{ display: 'block', ...muted }}>
                {[a.applied_at && `applied ${day(a.applied_at)}`, a.source, a.location, a.interviews?.length ? `${a.interviews.length} interview round${a.interviews.length === 1 ? '' : 's'}` : null, `added ${day(a.created_at)}`].filter(Boolean).join(' · ')}
              </span>
            </span>
          </label>
        ))}
      </div>
      <div style={{ display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' }}>
        <button type="button" className="btn-primary" disabled={busy} onClick={() => run(() => mergeApplications(store, keep, group.ids.filter((id) => id !== keep)))}>
          <Icon name="check" size={12} /> {busy ? 'Merging…' : 'Merge into the one I picked'}
        </button>
        <button type="button" className="btn-secondary" disabled={busy} onClick={() => run(() => dismissDuplicates(store, group.ids, company))}>
          They're different
        </button>
        <span style={muted}>Merging keeps its stage and fills in what the others had: notes, interview rounds, links, the earliest applied date.</span>
      </div>
      {error && <div role="alert" style={{ ...muted, color: danger }}>{error}</div>}
    </div>
  )
}

/** All groups (the chat), or the first few with a "more" (Landed's questions). */
export function DuplicatesReview({ limit, emptyText }: { limit?: number; emptyText?: string }) {
  const dups = useDuplicates()
  const [all, setAll] = useState(false)
  if (!dups.data) return dups.isLoading ? <div style={muted}>Looking for duplicates…</div> : null
  if (dups.data.length === 0) return emptyText ? <div style={{ ...card, fontSize: 12.5 }}><span><Icon name="check" size={12} /> {emptyText}</span></div> : null
  const shown = all || !limit ? dups.data : dups.data.slice(0, limit)
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
      {shown.map((g) => <GroupCard key={g.ids.join('+')} group={g} />)}
      {shown.length < dups.data.length && (
        <button type="button" className="btn-secondary" onClick={() => setAll(true)} style={{ alignSelf: 'flex-start' }}>
          {dups.data.length - shown.length} more possible duplicate{dups.data.length - shown.length === 1 ? '' : 's'}
        </button>
      )}
    </div>
  )
}
