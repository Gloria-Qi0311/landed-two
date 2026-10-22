// "Import" on the Applications page: applications from a spreadsheet the
// user already keeps (lib/import-applications.ts). Choose a CSV or paste
// cells → check what each column is and what each row will do → import,
// with Undo, and (with email checks set up) read email back far enough to
// bring the imported ones up to date.
import { useEffect, useMemo, useState, type CSSProperties, type ReactNode } from 'react'
import { useNavigate } from 'react-router-dom'
import { useQueryClient } from '@tanstack/react-query'
import type { StageValue } from '@landed/schema/pipeline'
import { Icon } from './primitives'
import { danger, muted } from './ui'
import { useStore } from '../lib/store'
import type { DbApplication, DbCompany } from '../lib/store/types'
import {
  FIELD_LABEL, IMPORT_FIELDS, decodeBytes, emailAfterImport, findHeader, guessMapping, planImport, readRows, readStatus, readTable, runImport, undoImport,
  unreadStatuses, type AgentStages, type ColumnUse, type ImportField, type ImportOutcome, type Planned, type StatusReading,
} from '../lib/import-applications'
import { bridgeCall } from '../lib/extension-bridge'
import { useExtension } from '../hooks/auto-apply'
import { computerCan, designate, requestRunNow, syncTargets } from '../lib/automation-sync'
import { useAutomations } from '../hooks/automation'
import { useRuntimes } from '../hooks/runtimes'

const STAGE_LABEL: Record<StageValue, string> = {
  saved: 'Lead (not applied)', applied: 'Applied', oa: 'OA / Test', interview: 'Interview', offer: 'Offer', rejected: 'Rejected', ghosted: 'Ghosted',
}
const STAGES = Object.keys(STAGE_LABEL) as StageValue[]
/** How far back "update from email" reads: the oldest import, at most 90 days. */
const MAX_EMAIL_DAYS = 90
const DAY = 86_400_000

const yellow = 'oklch(0.96 0.06 90)'
const small: CSSProperties = { fontSize: 11.5, padding: '3px 9px' }
const input: CSSProperties = {
  width: '100%', padding: '6px 10px', fontSize: 12, background: 'var(--surface)', color: 'var(--fg)',
  border: '0.5px solid var(--border)', borderRadius: 6, outline: 'none', fontFamily: 'inherit', boxSizing: 'border-box',
}

/** How far back to read email for an import: from its oldest applied date (a
 *  week at least), at most 90 days. */
function daysToRead(earliest: string | null): number {
  return earliest ? Math.min(MAX_EMAIL_DAYS, Math.max(7, Math.ceil((Date.now() - Date.parse(earliest)) / DAY) + 1)) : MAX_EMAIL_DAYS
}

type Sheet = { table: { line: number; cells: string[] }[]; header: number; mapping: ColumnUse[] }

/** The emails a run can bring these up to date from, if this account's computer reads email. */
function useEmailCheck() {
  const { automations } = useAutomations()
  const runtimes = useRuntimes()
  const designated = designate(syncTargets(runtimes.data ?? []), automations)
  return {
    canRead: !!designated && computerCan(designated, 'email_check') && designated.runtime.agents.some((a) => a.kinds?.includes('email_check')),
    // Check email's switch on Workflow: off means Landed doesn't read email on its own.
    enabled: automations.email_check.enabled,
  }
}

export function ImportApplicationsModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { store } = useStore()
  const qc = useQueryClient()
  const navigate = useNavigate()
  const email = useEmailCheck()
  const [sheet, setSheet] = useState<Sheet | null>(null)
  const [pasted, setPasted] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [existing, setExisting] = useState<{ apps: DbApplication[]; companies: DbCompany[] } | null>(null)
  // The user's changes to the plan, by sheet line: a stage, and whether the row goes in.
  const [stageFor, setStageFor] = useState<Record<number, StageValue>>({})
  // By status: the user's pick, and what their agent read (statuses the rules can't).
  const [statusFor, setStatusFor] = useState<Record<string, StageValue>>({})
  const [agent, setAgent] = useState<{ stages: AgentStages | null; asking: boolean; error: string | null }>({ stages: null, asking: false, error: null })
  const extension = useExtension()
  const [include, setInclude] = useState<Record<number, boolean>>({})
  const [busy, setBusy] = useState(false)
  const [done, setDone] = useState<ImportOutcome | null>(null)
  const [emailAsked, setEmailAsked] = useState(false)

  useEffect(() => {
    if (!open) return
    setSheet(null); setPasted(''); setError(null); setStageFor({}); setStatusFor({}); setInclude({}); setDone(null); setEmailAsked(false)
    void Promise.all([store.listApplications(), store.listCompanies()]).then(([apps, companies]) => setExisting({ apps, companies }))
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [open, onClose, store])

  // Statuses the rules can't read go to the user's own agent: only those words.
  const unread = useMemo(() => (sheet ? unreadStatuses(readRows(sheet.table, sheet.header, sheet.mapping)) : []), [sheet])
  const unreadKey = unread.join('\u0000')
  useEffect(() => {
    if (!unread.length) { setAgent({ stages: null, asking: false, error: null }); return }
    if (extension.isLoading) return
    if (!extension.data) { setAgent({ stages: null, asking: false, error: 'no_extension' }); return }
    let live = true
    setAgent({ stages: null, asking: true, error: null })
    void bridgeCall<{ stages: AgentStages }>('classify-statuses', { statuses: unread }, 70_000).then((res) => {
      if (live) setAgent(res.ok ? { stages: res.data.stages ?? {}, asking: false, error: null } : { stages: null, asking: false, error: res.error })
    })
    return () => { live = false }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- by the statuses, not the array
  }, [unreadKey, extension.isLoading, extension.data])
  const reading = (status: string) => readStatus(status, agent.stages, statusFor)

  const plan = useMemo<Planned[]>(() => {
    if (!sheet || !existing) return []
    const rows = readRows(sheet.table, sheet.header, sheet.mapping, new Date(), (status) => readStatus(status, agent.stages, statusFor))
    return planImport(rows, existing.apps, existing.companies).map((p) => {
      const stage = stageFor[p.line] ?? p.stage
      const forced = include[p.line]
      // "Already in Landed" can still be added on purpose; an update or an add can be left out.
      if (p.action === 'skip' && p.reason === 'in Landed' && forced) return { ...p, stage, action: 'add' as const, stageSure: true }
      if (p.action !== 'skip' && forced === false) return { ...p, stage, action: 'skip' as const }
      return { ...p, stage, stageSure: p.stageSure || p.line in stageFor }
    })
  }, [sheet, existing, stageFor, include, agent.stages, statusFor])

  if (!open) return null

  const load = (text: string) => {
    const table = readTable(text)
    if (table.length < 2) { setError('That doesn\'t look like a table: it needs a header row and at least one application.'); return }
    const header = findHeader(table)
    setError(null); setStageFor({}); setStatusFor({}); setInclude({})
    setSheet({ table, header, mapping: guessMapping(table[header].cells) })
  }
  const onFile = async (file: File | undefined) => {
    if (!file) return
    if (/\.(xlsx|xls|numbers)$/i.test(file.name)) {
      setError('That\'s a spreadsheet file, not a CSV. Either select the cells in it, copy, and paste them below, or save it as CSV (File → Save As / Download → CSV) and choose that.')
      return
    }
    if (file.size > 5_000_000) { setError('That file is over 5 MB. Is it the right one?'); return }
    load(decodeBytes(await file.arrayBuffer()))
  }

  const adds = plan.filter((p) => p.action === 'add')
  const updates = plan.filter((p) => p.action === 'update')
  const backs = updates.filter((p) => p.back)
  const dupes = plan.filter((p) => p.reason === 'in Landed' || p.reason === 'twice in the sheet')
  const broken = plan.filter((p) => p.reason === 'no company' || p.reason === 'no role')
  const missing = sheet ? (['company', 'role'] as const).filter((f) => !sheet.mapping.includes(f)) : []

  const doImport = async () => {
    setBusy(true); setError(null)
    try {
      const outcome = await runImport(store, plan)
      setDone(outcome)
      // Brought up to date from email on its own, in the background: the user
      // needn't wait here (the Applications page says while it runs).
      if (emailAfterImport({ ...email, changed: outcome.added.length + outcome.updated.length }) === 'auto') {
        requestRunNow('email_check', { rescanDays: daysToRead(outcome.earliest) })
        setEmailAsked(true)
      }
    } catch (e) {
      setError(`Couldn't import: ${(e as Error).message}`)
    } finally {
      setBusy(false)
      void qc.invalidateQueries({ queryKey: ['applications'] })
      void qc.invalidateQueries({ queryKey: ['companies'] })
      void qc.invalidateQueries({ queryKey: ['job_leads'] })
    }
  }
  const undo = async () => {
    if (!done) return
    setBusy(true)
    try {
      await undoImport(store, done)
      onClose()
    } catch (e) {
      setError(`Couldn't undo: ${(e as Error).message}`)
    } finally {
      setBusy(false)
      void qc.invalidateQueries({ queryKey: ['applications'] })
      void qc.invalidateQueries({ queryKey: ['companies'] })
      void qc.invalidateQueries({ queryKey: ['job_leads'] })
    }
  }
  const emailDays = daysToRead(done?.earliest ?? null)

  const afterImport = done ? emailAfterImport({ ...email, changed: done.added.length + done.updated.length }) : 'none'
  let body: ReactNode
  if (done) {
    const parts = [
      done.added.length && `Added ${done.added.length} application${done.added.length === 1 ? '' : 's'}`,
      done.updated.length && `updated ${done.updated.length}`,
    ].filter(Boolean).join(', ')
    body = (
      <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13.5, fontWeight: 600 }}>
          <Icon name="check" size={15} /> {parts || 'Nothing to import'}.
        </div>
        {done.leads.length > 0 && (
          <div style={muted}>
            {done.leads.length} job{done.leads.length === 1 ? '' : 's'} in Leads {done.leads.length === 1 ? 'was' : 'were'} one you'd already applied to, so {done.leads.length === 1 ? 'it' : 'they'} left Leads, and a search won't bring {done.leads.length === 1 ? 'it' : 'them'} back.
          </div>
        )}
        <div style={muted}>
          {emailAsked
            ? <>Your sheet says where each one stood when you saved it. Landed is reading your email from the last {emailDays} days in the background to bring them up to date (an interview invite, a rejection). You can close this: updates show up on the board as they come in, and ones it isn't sure about ask you first.</>
            : afterImport === 'offer'
              ? 'Your sheet says where each one stood when you saved it. Check email is off on Workflow, so Landed didn\'t read your email on its own; you can have it read once now to bring them up to date.'
              : 'Your sheet says where each one stood when you saved it. Emails since then (an interview invite, a rejection) can bring them up to date.'}
        </div>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
          {emailAsked || afterImport === 'none' ? (
            <button type="button" className="btn-primary" onClick={onClose}>Done</button>
          ) : afterImport === 'offer' || afterImport === 'auto' ? (
            <button type="button" className="btn-primary"
              onClick={() => { requestRunNow('email_check', { rescanDays: emailDays }); setEmailAsked(true) }}>
              <Icon name="inbox" size={13} /> Update them from email (last {emailDays} days)
            </button>
          ) : (
            <button type="button" className="btn-secondary" onClick={() => { onClose(); navigate('/workflow#email') }}>
              Set up email checks to keep them up to date
            </button>
          )}
          <button type="button" className="btn-secondary" disabled={busy} onClick={() => void undo()}>Undo the import</button>
        </div>
      </div>
    )
  } else if (!sheet) {
    body = (
      <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
        <div style={muted}>
          Bring in the applications you've been tracking in Excel, Numbers or Google Sheets. Landed reads the columns (English or Chinese
          headers), shows you what each row will become, and adds nothing until you say so. Rows already in Landed are left alone.
        </div>
        <label className="btn-secondary" style={{ alignSelf: 'flex-start', cursor: 'pointer' }}>
          <Icon name="upload" size={13} /> Choose a CSV file
          <input type="file" accept=".csv,.tsv,.txt,text/csv" hidden onChange={(e) => { void onFile(e.target.files?.[0]); e.target.value = '' }} />
        </label>
        <div>
          <div style={{ ...muted, marginBottom: 4 }}>Or select the cells in your spreadsheet (with the header row), copy, and paste here:</div>
          <textarea value={pasted} onChange={(e) => setPasted(e.target.value)} rows={6}
            placeholder={'Company\tRole\tStatus\tDate applied\nKestrel Pay\tData Analyst\tInterview\t9/15'}
            style={{ ...input, fontFamily: 'var(--font-mono, monospace)', resize: 'vertical' }} />
          <button type="button" className="btn-primary" style={{ marginTop: 8 }} disabled={!pasted.trim()} onClick={() => load(pasted)}>
            Read these rows
          </button>
        </div>
        <div style={muted}>Everything is read in your browser. Columns that look like passwords are never read.</div>
      </div>
    )
  } else {
    const header = sheet.table[sheet.header].cells
    body = (
      <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
        <Columns header={header} mapping={sheet.mapping} missing={missing}
          onChange={(i, use) => setSheet({ ...sheet, mapping: sheet.mapping.map((u, j) => (j === i ? use : u)) })} />

        <div style={{ fontSize: 12.5 }}>
          <b>{adds.length}</b> to add
          {updates.length > backs.length && <> · <b>{updates.length - backs.length}</b> already in Landed and further along in your sheet</>}
          {backs.length > 0 && <> · <b>{backs.length}</b> in Landed as Applied but not applied yet in your sheet: back to Leads</>}
          {dupes.length > 0 && <> · <b>{dupes.length}</b> already in Landed or twice in the sheet (left out)</>}
          {broken.length > 0 && <> · <b>{broken.length}</b> without a company or role (left out)</>}
        </div>

        <Statuses plan={plan} reading={reading} agent={agent}
          onPick={(status, stage) => setStatusFor({ ...statusFor, [status]: stage })} />

        <div style={{ overflow: 'auto', maxHeight: '42vh', borderTop: '0.5px solid var(--border-subtle)' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
            <thead>
              <tr style={{ textAlign: 'left', color: 'var(--fg-muted)', fontSize: 11 }}>
                {['Row', 'Company', 'Role', 'Status', 'Applied', 'What happens'].map((h) => (
                  <th key={h} style={{ padding: '6px 6px', fontWeight: 500, position: 'sticky', top: 0, background: 'var(--surface)' }}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {plan.map((p) => (
                <tr key={p.line} style={{ borderTop: '0.5px solid var(--border-subtle)', opacity: p.action === 'skip' ? 0.55 : 1 }}>
                  <td style={{ padding: '5px 6px', color: 'var(--fg-muted)' }}>{p.line}</td>
                  <td style={{ padding: '5px 6px' }}>{p.company || '—'}</td>
                  <td style={{ padding: '5px 6px' }}>{p.role || '—'}</td>
                  <td style={{ padding: '5px 6px' }}>
                    {p.reason === 'no company' || p.reason === 'no role' ? (p.status || '') : (
                      <select value={p.stage} title={p.status ? `Your sheet: ${p.status}` : undefined}
                        onChange={(e) => setStageFor({ ...stageFor, [p.line]: e.target.value as StageValue })}
                        style={{ ...input, width: 'auto', padding: '2px 6px', background: p.stageSure ? 'var(--surface)' : yellow }}>
                        {STAGES.map((s) => <option key={s} value={s}>{STAGE_LABEL[s]}</option>)}
                      </select>
                    )}
                  </td>
                  <td style={{ padding: '5px 6px', color: 'var(--fg-muted)', whiteSpace: 'nowrap' }}>{p.application.applied_at?.slice(0, 10) ?? ''}</td>
                  <td style={{ padding: '5px 6px' }}><RowAction p={p} include={include} setInclude={setInclude} /></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    )
  }

  const count = adds.length + updates.length
  return (
    <div onClick={(e) => { if (e.target === e.currentTarget) onClose() }}
      style={{
        position: 'fixed', inset: 0, zIndex: 250, background: 'oklch(0.18 0.01 240 / 0.45)', backdropFilter: 'blur(2px)',
        display: 'flex', alignItems: 'flex-start', justifyContent: 'center', paddingTop: '6vh', animation: 'slideIn 160ms ease',
      }}>
      <div role="dialog" aria-label="Import applications" style={{
        width: sheet && !done ? 900 : 560, maxWidth: 'calc(100vw - 32px)', background: 'var(--surface)', borderRadius: 12,
        boxShadow: '0 24px 64px rgba(0,0,0,0.22)', display: 'flex', flexDirection: 'column', maxHeight: '88vh',
      }}>
        <div style={{ padding: '14px 18px', borderBottom: '0.5px solid var(--border)', display: 'flex', alignItems: 'center', gap: 10 }}>
          <Icon name="table" size={15} />
          <div style={{ fontSize: 13, fontWeight: 600 }}>Import applications from a spreadsheet</div>
          <button type="button" onClick={onClose} aria-label="Close" className="icon-btn"
            style={{ marginLeft: 'auto', background: 'transparent', border: 'none', color: 'var(--fg-muted)', cursor: 'pointer', padding: 6, borderRadius: 5, display: 'flex' }}>
            <Icon name="x" size={15} />
          </button>
        </div>
        <div style={{ padding: '14px 18px', overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: 10 }}>
          {body}
          {error && <div style={{ ...muted, color: danger }}>{error}</div>}
        </div>
        {sheet && !done && (
          <div style={{ padding: '12px 18px', borderTop: '0.5px solid var(--border)', display: 'flex', gap: 8, alignItems: 'center' }}>
            <button type="button" className="btn-ghost" style={small} onClick={() => { setSheet(null); setError(null) }}>Back</button>
            <button type="button" className="btn-primary" style={{ marginLeft: 'auto' }}
              disabled={busy || agent.asking || count === 0 || missing.length > 0} onClick={() => void doImport()}>
              {busy ? 'Importing…' : agent.asking ? 'Reading statuses…' : count === 0 ? 'Nothing to import' : `Import ${count}`}
            </button>
          </div>
        )}
      </div>
    </div>
  )
}

/** What each column of the sheet becomes: one summary line (most sheets need
 *  nothing changed), and the per-column choices behind "Change", shown at
 *  once when the company or role column wasn't found. */
function Columns({ header, mapping, missing, onChange }: {
  header: string[]; mapping: ColumnUse[]; missing: readonly ('company' | 'role')[]; onChange: (i: number, use: ColumnUse) => void
}) {
  const [open, setOpen] = useState(false)
  const name = (i: number) => header[i] || `Column ${i + 1}`
  const cols = mapping.map((use, i) => ({ use, i }))
  const own = cols.filter((c) => c.use !== 'notes' && c.use !== 'skip' && c.use !== 'secret')
  const notes = cols.filter((c) => c.use === 'notes')
  const left = cols.filter((c) => c.use === 'skip' && header[c.i])
  const secret = cols.filter((c) => c.use === 'secret')
  const list = (cs: { i: number }[]) => cs.map((c) => name(c.i)).join(', ')
  const editing = open || missing.length > 0
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
      <div style={{ display: 'flex', alignItems: 'flex-start', gap: 10 }}>
        <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: 3, fontSize: 12.5, lineHeight: 1.5 }}>
          <div style={{ display: 'flex', gap: 6 }}>
            <span style={{ flexShrink: 0, marginTop: 2 }}><Icon name="check" size={13} /></span>
            <span>
              Landed read your columns:{' '}
              {own.map((c, k) => <span key={c.i}>{k ? ', ' : ''}{name(c.i)} → <b>{FIELD_LABEL[c.use as ImportField]}</b></span>)}
            </span>
          </div>
          {notes.length > 0 && (
            <div style={{ ...muted, paddingLeft: 19 }}>
              Added to each application's notes, so nothing is lost: {list(notes)}
            </div>
          )}
          {left.length > 0 && <div style={{ ...muted, paddingLeft: 19 }}>Left out: {list(left)}</div>}
          {secret.length > 0 && <div style={{ ...muted, paddingLeft: 19 }}>Never read (looks like a password): {list(secret)}</div>}
        </div>
        {missing.length === 0 && (
          <button type="button" className="btn-secondary" style={{ ...small, flexShrink: 0 }} onClick={() => setOpen(!open)}>
            {open ? 'Done' : 'Change'}
          </button>
        )}
      </div>
      {missing.length > 0 && (
        <div style={{ ...muted, color: danger }}>
          Which column is the {missing.map((f) => FIELD_LABEL[f].toLowerCase()).join(' and the ')}? Every application needs both: pick it below.
        </div>
      )}
      {editing && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6, paddingTop: 6 }}>
          <div style={muted}>Your column → saved in Landed as</div>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(340px, 1fr))', columnGap: 20, rowGap: 6 }}>
            {cols.map(({ use, i }) => (
              <label key={i} style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12 }}>
                <span style={{ width: 120, flexShrink: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{name(i)}</span>
                <span style={{ color: 'var(--fg-muted)' }}>→</span>
                {use === 'secret' ? (
                  <span style={muted}>Never read (looks like a password)</span>
                ) : (
                  <select value={use} style={{ ...input, flex: 1, width: 'auto' }} onChange={(e) => onChange(i, e.target.value as ColumnUse)}>
                    {IMPORT_FIELDS.filter((f) => f !== 'notes').map((f) => <option key={f} value={f}>{FIELD_LABEL[f]}</option>)}
                    <option value="notes">Add to notes</option>
                    <option value="skip">Leave out (ignore this column)</option>
                  </select>
                )}
              </label>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}

const BY: Record<NonNullable<StatusReading['by']>, string> = { rules: 'read by Landed', agent: 'read by your agent', you: 'your pick' }

/** Every status in the sheet, how many rows have it, and the stage it means:
 *  one pick changes all its rows. Not sure is yellow. */
function Statuses({ plan, reading, agent, onPick }: {
  plan: Planned[]
  reading: (status: string) => StatusReading
  agent: { asking: boolean; error: string | null }
  onPick: (status: string, stage: StageValue) => void
}) {
  const counts = new Map<string, number>()
  for (const p of plan) if (!p.problem) counts.set(p.status, (counts.get(p.status) ?? 0) + 1)
  if (counts.size === 0) return null
  const list = [...counts.entries()].sort((a, b) => b[1] - a[1])
  const unsure = list.some(([status]) => !reading(status).sure)
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
      <div style={{ fontSize: 11, fontWeight: 600, color: 'var(--fg-muted)', textTransform: 'uppercase', letterSpacing: '0.05em' }}>Statuses</div>
      {list.map(([status, n]) => {
        const r = reading(status)
        return (
          <div key={status} style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12 }}>
            <span style={{ minWidth: 0, flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              {status ? `“${status}”` : <span style={muted}>(no status)</span>} <span style={muted}>· {n} row{n === 1 ? '' : 's'}</span>
            </span>
            <span style={{ ...muted, fontSize: 11 }}>{r.by ? BY[r.by] : agent.asking ? 'your agent is reading it…' : 'not sure'}</span>
            <select value={r.stage} aria-label={`Stage for ${status || 'rows with no status'}`} onChange={(e) => onPick(status, e.target.value as StageValue)}
              style={{ ...input, width: 'auto', padding: '2px 6px', background: r.sure ? 'var(--surface)' : yellow }}>
              {STAGES.map((st) => <option key={st} value={st}>{STAGE_LABEL[st]}</option>)}
            </select>
          </div>
        )
      })}
      {unsure && !agent.asking && (
        <div style={muted}>
          Yellow: {agent.error ? 'your agent could not read it' : 'not sure'}, so Applied when a row has an applied date, otherwise a lead. Pick the right stage
          {agent.error === 'no_extension' ? ' (with the Landed extension and Landed for Mac, your agent reads statuses like these).' : '.'}
        </div>
      )}
    </div>
  )
}

function RowAction({ p, include, setInclude }: { p: Planned; include: Record<number, boolean>; setInclude: (v: Record<number, boolean>) => void }) {
  const toggle = (on: boolean) => setInclude({ ...include, [p.line]: on })
  if (p.reason === 'no company') return <span style={{ color: danger }}>No company: left out</span>
  if (p.reason === 'no role') return <span style={{ color: danger }}>No role: left out</span>
  if (p.reason === 'twice in the sheet') return <span style={{ color: 'var(--fg-muted)' }}>Same as a row above: added once</span>
  if (p.existing && (p.action === 'update' || include[p.line] === false && p.reason !== 'in Landed')) {
    return (
      <label style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
        <input type="checkbox" checked={p.action === 'update'} onChange={(e) => toggle(e.target.checked)} />
        In Landed as {STAGE_LABEL[p.existing.stage as StageValue] ?? p.existing.stage}: move to {STAGE_LABEL[p.stage]}
      </label>
    )
  }
  if (p.reason === 'in Landed' || (p.existing && p.action === 'add')) {
    return (
      <label style={{ display: 'flex', alignItems: 'center', gap: 6, color: 'var(--fg-muted)' }}>
        <input type="checkbox" checked={p.action === 'add'} onChange={(e) => toggle(e.target.checked)} />
        Already in Landed{p.existing ? ` as ${STAGE_LABEL[p.existing.stage as StageValue] ?? p.existing.stage}` : ''}{p.existing && p.existing.role !== p.role ? ` (${p.existing.role})` : ''}: add anyway
      </label>
    )
  }
  return (
    <label style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
      <input type="checkbox" checked={p.action === 'add'} onChange={(e) => toggle(e.target.checked)} />
      Add
    </label>
  )
}
