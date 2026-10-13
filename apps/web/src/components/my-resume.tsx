// My Resume, beyond the uploads: the master resume (merged from every
// upload by the user's own agent — every job, project and bullet, with every
// way each bullet was phrased) and versions tailored to a role from it.
// Data + rules: packages/schema/src/master-resume.ts; tasks: lib/resume-tasks.ts.
import { useEffect, useMemo, useRef, useState } from 'react'
import { masterStats, parseTarget, type MasterEntry, type MasterResume } from '@landed/schema/master-resume'
import { Icon } from './primitives'
import { formatRelative } from '../lib/time'
import { flattenMaster, useResumeTask } from '../lib/resume-tasks'
import type { DbResume } from '../lib/store'
import { useResumeGroups, useUpdateResume } from '../hooks/resumes'
import { agentFor, useRuntimes, type TaskKind } from '../hooks/runtimes'
import { useApplications, useCompanies } from '../hooks/queries'
import { useJobLeads } from '../hooks/inbox'

const muted = { fontSize: 12, color: 'var(--fg-muted)', lineHeight: 1.55 } as const
const danger = 'oklch(0.45 0.15 30)'
const card = { background: 'var(--surface)', border: '0.5px solid var(--border)', borderRadius: 10, padding: 16 } as const
const KIND_LABEL = { experience: 'Experience', internship: 'Internships', project: 'Projects' } as const

/** Where the work runs, or what to do to make it run. */
function AgentLine({ kind }: { kind: TaskKind }) {
  const a = agentFor(useRuntimes().data, kind)
  return (
    <div style={{ ...muted, fontSize: 11.5 }}>
      {a.agent
        ? <>Runs on {a.agent.label} on {a.runtime.name}, with your own subscription.</>
        : a.outdated
          ? <>The Landed daemon on your computer needs an update: stop it and run <code>pnpm landed start</code> again.</>
          : <>Needs your computer online: run <code>pnpm landed start</code> (or connect it in Applications → Ask Agent).</>}
    </div>
  )
}

function TaskStatus({ kind, running }: { kind: 'resume_merge' | 'resume_tailor'; running: string }) {
  const task = useResumeTask((s) => s.task)
  if (!task || task.kind !== kind) return null
  if (task.status === 'running') {
    return (
      <div style={{ ...muted, display: 'flex', alignItems: 'center', gap: 6 }}>
        <span style={{ display: 'flex', animation: 'pulse 1.6s ease-in-out infinite', color: 'var(--accent)' }}><Icon name="sparkle" size={12} /></span>
        {running} with {task.label}…
      </div>
    )
  }
  if (task.status === 'error') return <div role="alert" style={{ ...muted, color: danger }}>{task.error}</div>
  return null
}

// ── master ────────────────────────────────────────────────────────────────

export function MasterPane({ onUpload }: { onUpload: () => void }) {
  const { master, sources } = useResumeGroups()
  const runtimes = useRuntimes()
  const task = useResumeTask((s) => s.task)
  const merge = useResumeTask((s) => s.merge)
  const target = agentFor(runtimes.data, 'resume_merge')
  const merging = task?.kind === 'resume_merge' && task.status === 'running'
  const m = master?.master_json ?? null
  const usable = sources.filter((s) => s.parsed_json)
  const fresh = m ? usable.filter((s) => !m.sources.some((x) => x.id === s.id)) : usable

  const build = () => target.agent && void merge({ runtime: target.runtime, agent: target.agent }, usable, master)

  if (!m) {
    return (
      <div style={{ maxWidth: 760, display: 'flex', flexDirection: 'column', gap: 14 }}>
        <div style={card}>
          <div style={{ fontSize: 15, fontWeight: 600, marginBottom: 6 }}>Your master resume</div>
          <div style={muted}>
            One complete record of your career, merged from every resume you've uploaded: every job, internship and project, and
            every bullet with all the ways you've phrased it. Versions for specific roles are built from it, using the most relevant
            experience and the phrasing that fits best.
          </div>
          <div style={{ marginTop: 14, display: 'flex', flexDirection: 'column', gap: 8 }}>
            {usable.length === 0 ? (
              <>
                <div style={muted}>Upload at least one resume first. The more versions of your resume you upload, the more complete the master gets.</div>
                <div><button className="btn-primary" onClick={onUpload}><Icon name="plus" size={12} /> Upload a resume</button></div>
              </>
            ) : (
              <>
                <div>
                  <button className="btn-primary" disabled={!target.agent || merging} onClick={build} style={{ opacity: !target.agent || merging ? 0.6 : 1 }}>
                    <Icon name="sparkle" size={12} /> {merging ? 'Building…' : `Build from ${usable.length} uploaded resume${usable.length === 1 ? '' : 's'}`}
                  </button>
                </div>
                <AgentLine kind="resume_merge" />
              </>
            )}
            <TaskStatus kind="resume_merge" running="Merging your resumes" />
          </div>
        </div>
      </div>
    )
  }

  const stats = masterStats(m)
  return (
    <div style={{ maxWidth: 820, display: 'flex', flexDirection: 'column', gap: 14 }}>
      <div style={{ ...card, display: 'flex', flexDirection: 'column', gap: 8 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
          <div style={{ fontSize: 15, fontWeight: 600 }}>Master resume</div>
          <span style={muted}>
            {stats.entries} roles & projects · {stats.bullets} bullets · {stats.alternatives} alternative phrasing{stats.alternatives === 1 ? '' : 's'}
          </span>
          <button className={fresh.length ? 'btn-primary' : 'btn-secondary'} disabled={!target.agent || merging} onClick={build}
            style={{ marginLeft: 'auto', opacity: !target.agent || merging ? 0.6 : 1 }}>
            <Icon name="refresh" size={12} /> {merging ? 'Rebuilding…' : fresh.length ? `Add ${fresh.length} new upload${fresh.length === 1 ? '' : 's'}` : 'Rebuild'}
          </button>
        </div>
        <div style={muted}>
          Built from {m.sources.map((s) => s.name).join(', ') || 'your uploads'} · {formatRelative(m.built_at)}. Rebuilding keeps
          your choices below. Choose the phrasing you prefer for each bullet; versions start from it.
        </div>
        <TaskStatus kind="resume_merge" running="Merging your resumes" />
        {!target.agent && <AgentLine kind="resume_merge" />}
      </div>
      <MasterEditor row={master!} master={m} />
    </div>
  )
}

function MasterEditor({ row, master }: { row: DbResume; master: MasterResume }) {
  const update = useUpdateResume()
  const save = (next: MasterResume) => update.mutate({ id: row.id, patch: { master_json: next, parsed_json: flattenMaster(next) } })
  const editEntry = (id: string, fn: (e: MasterEntry) => MasterEntry | null) =>
    save({ ...master, entries: master.entries.flatMap((e) => (e.id === id ? (fn(e) ? [fn(e)!] : []) : [e])) })
  const sourceName = (id: string) => master.sources.find((s) => s.id === id)?.name ?? 'an upload'
  const b = master.basic

  return (
    <>
      {(b.name || b.email) && (
        <div style={{ ...card, padding: 12, fontSize: 12.5 }}>
          <b>{b.name}</b>
          <span style={{ color: 'var(--fg-muted)' }}>{[b.email, b.phone, b.location, b.linkedin].filter(Boolean).map((x) => ` · ${x}`).join('')}</span>
        </div>
      )}
      {(['experience', 'internship', 'project'] as const).map((kind) => {
        const entries = master.entries.filter((e) => e.kind === kind)
        if (entries.length === 0) return null
        return (
          <div key={kind} style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            <div style={{ fontSize: 11, fontWeight: 600, color: 'var(--fg-muted)', textTransform: 'uppercase', letterSpacing: '0.05em' }}>{KIND_LABEL[kind]}</div>
            {entries.map((e) => (
              <div key={e.id} style={{ ...card, padding: 12 }}>
                <div style={{ display: 'flex', alignItems: 'baseline', gap: 8 }}>
                  <div style={{ fontSize: 13, fontWeight: 600 }}>{e.org}</div>
                  <div style={{ fontSize: 12.5 }}>{e.title}</div>
                  <div style={{ ...muted, fontSize: 11.5, marginLeft: 'auto' }}>{[e.start_date, e.current ? 'now' : e.end_date].filter(Boolean).join(' – ')}</div>
                  <button className="icon-btn" title="Remove from the master" aria-label="Remove from the master"
                    onClick={() => confirm(`Remove ${e.org} from your master resume?`) && editEntry(e.id, () => null)}
                    style={{ background: 'transparent', border: 'none', color: 'var(--fg-muted)', cursor: 'pointer', padding: 2, display: 'flex' }}>
                    <Icon name="x" size={12} />
                  </button>
                </div>
                <div style={{ marginTop: 8, display: 'flex', flexDirection: 'column', gap: 6 }}>
                  {e.bullets.map((bullet) => (
                    <BulletRow key={bullet.id} bullet={bullet} sourceName={sourceName}
                      onPrefer={(i) => editEntry(e.id, (x) => ({ ...x, bullets: x.bullets.map((y) => (y.id === bullet.id ? { ...y, preferred: i } : y)) }))}
                      onRemove={() => editEntry(e.id, (x) => ({ ...x, bullets: x.bullets.filter((y) => y.id !== bullet.id) }))} />
                  ))}
                </div>
              </div>
            ))}
          </div>
        )
      })}
      {master.education.length > 0 && (
        <div style={{ ...card, padding: 12, display: 'flex', flexDirection: 'column', gap: 4 }}>
          <div style={{ fontSize: 11, fontWeight: 600, color: 'var(--fg-muted)', textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: 2 }}>Education</div>
          {master.education.map((ed, i) => (
            <div key={i} style={{ fontSize: 12.5 }}>
              <b style={{ fontWeight: 500 }}>{ed.school}</b> {[ed.degree, ed.major].filter(Boolean).join(', ')}
              <span style={{ color: 'var(--fg-muted)' }}>{ed.end_date ? ` · ${ed.end_date}` : ''}</span>
            </div>
          ))}
        </div>
      )}
      {master.skills.length > 0 && (
        <div style={{ display: 'flex', gap: 5, flexWrap: 'wrap' }}>
          {master.skills.map((s) => <span key={s} style={{ fontSize: 11, padding: '2px 8px', borderRadius: 999, border: '0.5px solid var(--border)', background: 'var(--surface)' }}>{s}</span>)}
        </div>
      )}
      {update.error && <div role="alert" style={{ ...muted, color: danger }}>{(update.error as Error).message}</div>}
    </>
  )
}

function BulletRow({ bullet, sourceName, onPrefer, onRemove }: {
  bullet: MasterEntry['bullets'][number]
  sourceName: (id: string) => string
  onPrefer: (i: number) => void
  onRemove: () => void
}) {
  const [open, setOpen] = useState(false)
  const alternatives = bullet.variants.length - 1
  return (
    <div style={{ fontSize: 12.5, lineHeight: 1.5 }}>
      <div style={{ display: 'flex', gap: 6, alignItems: 'flex-start' }}>
        <span style={{ color: 'var(--fg-muted)' }}>•</span>
        <span style={{ flex: 1 }}>{bullet.variants[bullet.preferred]?.text}</span>
        {alternatives > 0 && (
          <button type="button" onClick={() => setOpen(!open)} style={{
            flexShrink: 0, fontSize: 10.5, padding: '0 6px', borderRadius: 999, cursor: 'pointer', fontFamily: 'inherit',
            background: open ? 'var(--surface-3)' : 'transparent', border: '0.5px solid var(--border)', color: 'var(--fg-muted)',
          }}>
            +{alternatives} phrasing{alternatives === 1 ? '' : 's'}
          </button>
        )}
        <button type="button" className="icon-btn" title="Remove this bullet" aria-label="Remove this bullet" onClick={onRemove}
          style={{ flexShrink: 0, background: 'transparent', border: 'none', color: 'var(--fg-muted)', cursor: 'pointer', padding: 2, display: 'flex' }}>
          <Icon name="x" size={11} />
        </button>
      </div>
      {open && (
        <div style={{ margin: '4px 0 4px 14px', display: 'flex', flexDirection: 'column', gap: 4 }}>
          {bullet.variants.map((v, i) => (
            <label key={i} style={{ display: 'flex', gap: 6, alignItems: 'flex-start', cursor: 'pointer', fontSize: 12 }}>
              <input type="radio" checked={i === bullet.preferred} onChange={() => onPrefer(i)} style={{ marginTop: 3 }} />
              <span style={{ flex: 1 }}>
                {v.text}
                <span style={{ color: 'var(--fg-muted)', fontSize: 11 }}> — from {v.from.map(sourceName).join(', ') || 'an upload'}</span>
              </span>
            </label>
          ))}
        </div>
      )}
    </div>
  )
}

// ── new version ───────────────────────────────────────────────────────────

type AppShape = { id: string; companyId: string; role: string; stage: string; portal_application_url: string | null }

export function NewVersionPane({ onCreated, onOpenMaster }: { onCreated: (id: string) => void; onOpenMaster: () => void }) {
  const { master } = useResumeGroups()
  const runtimes = useRuntimes()
  const task = useResumeTask((s) => s.task)
  const tailor = useResumeTask((s) => s.tailor)
  const target = agentFor(runtimes.data, 'resume_tailor')
  const apps = (useApplications().data ?? []) as AppShape[]
  const companies = (useCompanies().data ?? []) as { id: string; name: string }[]
  const leads = (useJobLeads().data ?? []).filter((l) => l.status === 'new')
  const [form, setForm] = useState({ role: '', company: '', job_url: '', jd_text: '', application_id: '' })
  const running = task?.kind === 'resume_tailor' && task.status === 'running'

  // Open the version as soon as it's written.
  const started = useRef<string | null>(null)
  useEffect(() => {
    if (task?.kind === 'resume_tailor' && task.status === 'done' && task.result_id && started.current === task.job_id) {
      started.current = null
      onCreated(task.result_id)
    }
  }, [task, onCreated])

  const options = useMemo(() => [
    ...apps.filter((a) => a.stage !== 'rejected' && a.stage !== 'ghosted').map((a) => ({
      key: `a:${a.id}`, label: `${companies.find((c) => c.id === a.companyId)?.name ?? ''} — ${a.role}`,
      fill: { role: a.role, company: companies.find((c) => c.id === a.companyId)?.name ?? '', job_url: a.portal_application_url ?? '', application_id: a.id },
    })),
    ...leads.map((l) => ({
      key: `l:${l.id}`, label: `${l.company_name} — ${l.title} (lead)`,
      fill: { role: l.title, company: l.company_name, job_url: l.job_url ?? '', application_id: '' },
    })),
  ], [apps, companies, leads])

  if (!master?.master_json) {
    return (
      <div style={{ ...card, maxWidth: 640 }}>
        <div style={{ fontSize: 15, fontWeight: 600, marginBottom: 6 }}>New version</div>
        <div style={muted}>Versions are built from your master resume. Build it first — it takes a minute.</div>
        <div style={{ marginTop: 12 }}><button className="btn-primary" onClick={onOpenMaster}>Go to master resume</button></div>
      </div>
    )
  }

  const t = parseTarget(form)
  const submit = async () => {
    if (!t || !target.agent) return
    await tailor({ runtime: target.runtime, agent: target.agent }, master.master_json!, t)
    started.current = useResumeTask.getState().task?.job_id ?? null
  }
  const field = (k: keyof typeof form, label: string, placeholder: string) => (
    <label style={{ display: 'flex', flexDirection: 'column', gap: 4, fontSize: 11.5, color: 'var(--fg-muted)' }}>
      {label}
      <input value={form[k]} onChange={(e) => setForm({ ...form, [k]: e.target.value })} placeholder={placeholder}
        style={{ padding: '6px 9px', fontSize: 12.5, fontFamily: 'inherit' }} />
    </label>
  )

  return (
    <div style={{ ...card, maxWidth: 680, display: 'flex', flexDirection: 'column', gap: 12 }}>
      <div>
        <div style={{ fontSize: 15, fontWeight: 600, marginBottom: 4 }}>New version</div>
        <div style={muted}>
          Your agent picks the experience and bullets from your master resume that fit this role best, uses the phrasing that
          matches it, and tells you why. It never adds anything that isn't in your master.
        </div>
      </div>
      {options.length > 0 && (
        <label style={{ display: 'flex', flexDirection: 'column', gap: 4, fontSize: 11.5, color: 'var(--fg-muted)' }}>
          From your board
          <select defaultValue="" onChange={(e) => {
            const o = options.find((x) => x.key === e.target.value)
            if (o) setForm({ ...form, ...o.fill })
          }} style={{ padding: '6px 9px', fontSize: 12.5, fontFamily: 'inherit' }}>
            <option value="">Pick an application or lead (optional)…</option>
            {options.map((o) => <option key={o.key} value={o.key}>{o.label}</option>)}
          </select>
        </label>
      )}
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
        {field('role', 'Target role *', 'e.g. Associate Product Manager, AI')}
        {field('company', 'Company', 'Optional')}
      </div>
      {field('job_url', 'Job link', 'Optional — your agent reads the posting if there is no description below')}
      <label style={{ display: 'flex', flexDirection: 'column', gap: 4, fontSize: 11.5, color: 'var(--fg-muted)' }}>
        Job description
        <textarea value={form.jd_text} onChange={(e) => setForm({ ...form, jd_text: e.target.value })} rows={6}
          placeholder="Optional — paste it for the best match"
          style={{ padding: '7px 9px', fontSize: 12.5, fontFamily: 'inherit', resize: 'vertical' }} />
      </label>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
        <button className="btn-primary" disabled={!t || !target.agent || running} onClick={submit}
          style={{ opacity: !t || !target.agent || running ? 0.6 : 1 }}>
          <Icon name="sparkle" size={12} /> {running ? 'Writing…' : 'Create version'}
        </button>
        <AgentLine kind="resume_tailor" />
      </div>
      <TaskStatus kind="resume_tailor" running={`Writing your ${task?.target?.role ?? ''} version`} />
    </div>
  )
}

// ── a version's "aimed at" + "why these" ──────────────────────────────────

export function VersionNotes({ resume }: { resume: DbResume }) {
  const t = resume.target_json
  const [open, setOpen] = useState(false)
  if (!t) return null
  return (
    <div style={{ ...card, padding: 12, maxWidth: 760, display: 'flex', flexDirection: 'column', gap: 6 }}>
      <div style={{ fontSize: 12.5 }}>
        <span style={{ color: 'var(--fg-muted)' }}>Aimed at </span><b style={{ fontWeight: 500 }}>{t.role}</b>
        {t.company && <> at <b style={{ fontWeight: 500 }}>{t.company}</b></>}
        {t.job_url && <> · <a href={t.job_url} target="_blank" rel="noopener noreferrer" style={{ color: 'var(--accent)' }}>posting</a></>}
        <span style={{ color: 'var(--fg-muted)' }}> · {formatRelative(resume.created_at)}</span>
      </div>
      {t.notes?.summary && <div style={muted}>{t.notes.summary}</div>}
      {t.notes?.picks?.length > 0 && (
        <div>
          <button type="button" onClick={() => setOpen(!open)} className="btn-secondary" style={{ fontSize: 11, padding: '2px 8px' }}>
            {open ? 'Hide' : 'Why these'} ({t.notes.picks.length})
          </button>
          {open && (
            <ul style={{ margin: '8px 0 0', paddingLeft: 18, fontSize: 12, lineHeight: 1.5 }}>
              {t.notes.picks.map((p, i) => <li key={i}><b style={{ fontWeight: 500 }}>{p.what}</b> <span style={{ color: 'var(--fg-muted)' }}>— {p.why}</span></li>)}
            </ul>
          )}
        </div>
      )}
    </div>
  )
}
