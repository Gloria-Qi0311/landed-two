// My Resume, beyond the uploads: the master resume (merged from every
// upload by the user's own agent — every job, project and bullet, with every
// way each bullet was phrased) and versions tailored to a role from it.
// Data + rules: packages/schema/src/master-resume.ts; tasks: lib/resume-tasks.ts.
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { masterStats, parseTarget, type Bullet, type MasterEducation, type MasterEntry, type MasterResume } from '@landed/schema/master-resume'
import { Icon } from './primitives'
import { EditableList, EditableText } from './editable'
import { formatRelative } from '../lib/time'
import { flattenMaster, useResumeTask } from '../lib/resume-tasks'
import type { DbResume } from '../lib/store'
import { useResumeGroups, useUpdateResume } from '../hooks/resumes'
import { agentFor, useRuntimes, type TaskKind } from '../hooks/runtimes'
import { useApplications, useCompanies } from '../hooks/queries'
import { useJobLeads } from '../hooks/inbox'
import { mutedLarge as muted, danger } from './ui'
import type { ResumePdf } from '../lib/resume-pdf'

const card = { background: 'var(--surface)', boxShadow: 'var(--shadow-sm)', borderRadius: 12, padding: 18 } as const
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
          : <>Needs your computer online: run <code>pnpm landed start</code> (or connect it on the Agent page).</>}
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

// ── upload ────────────────────────────────────────────────────────────────

export function UploadPane({ manual, onOpenMaster }: { manual: ReactNode; onOpenMaster: () => void }) {
  const target = agentFor(useRuntimes().data, 'resume_parse')
  const uploads = useResumeTask((s) => s.uploads)
  const upload = useResumeTask((s) => s.upload)
  const clear = useResumeTask((s) => s.clearUploads)
  const task = useResumeTask((s) => s.task)
  const [over, setOver] = useState(false)
  const [showManual, setShowManual] = useState(false)
  const picker = useRef<HTMLInputElement>(null)
  const busy = uploads.some((u) => u.status === 'preparing' || u.status === 'reading')
  const mergeDone = task?.kind === 'resume_merge' && task.status === 'done' && uploads.some((u) => u.status === 'saved') && !busy

  const send = (files: FileList | File[] | null) => {
    const list = Array.from(files ?? [])
    if (list.length && target.agent) void upload({ runtime: target.runtime, agent: target.agent }, list)
  }

  return (
    <div style={{ maxWidth: 760, display: 'flex', flexDirection: 'column', gap: 14 }}>
      <div>
        <div style={{ fontSize: 17, fontWeight: 600, fontFamily: 'var(--font-display)', marginBottom: 4 }}>Add your resumes</div>
        <div style={muted}>
          Add every resume you have: different versions, older ones, other languages. Your agent reads each one, and your master
          resume picks up anything new. The newest PDF or Word file is also kept for the extension to attach to applications.
        </div>
      </div>

      <div
        role="button" tabIndex={0}
        onClick={() => target.agent && picker.current?.click()}
        onKeyDown={(e) => { if ((e.key === 'Enter' || e.key === ' ') && target.agent) picker.current?.click() }}
        onDragOver={(e) => { e.preventDefault(); setOver(true) }}
        onDragLeave={() => setOver(false)}
        onDrop={(e) => { e.preventDefault(); setOver(false); send(e.dataTransfer.files) }}
        style={{
          border: `1.5px dashed ${over ? 'var(--accent)' : 'var(--border-strong)'}`, borderRadius: 12, padding: '34px 20px',
          background: over ? 'var(--surface-2)' : 'var(--surface)', textAlign: 'center', cursor: target.agent ? 'pointer' : 'default',
          opacity: target.agent ? 1 : 0.6,
        }}>
        <div style={{ display: 'flex', justifyContent: 'center', marginBottom: 8, color: 'var(--fg-muted)' }}><Icon name="download" size={22} /></div>
        <div style={{ fontSize: 13.5, fontWeight: 500 }}>Drop resumes here, or click to choose</div>
        <div style={{ ...muted, fontSize: 11.5, marginTop: 4 }}>PDF, Word (.docx), photo or text · several at once · up to 8 MB each</div>
        <input ref={picker} type="file" multiple hidden accept=".pdf,.docx,.png,.jpg,.jpeg,.webp,.txt,.md"
          onChange={(e) => { send(e.target.files); e.target.value = '' }} />
      </div>
      <AgentLine kind="resume_parse" />

      {uploads.length > 0 && (
        <div style={{ ...card, padding: 10, display: 'flex', flexDirection: 'column' }}>
          {uploads.map((u, i) => (
            <div key={u.id} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '6px 4px', borderTop: i ? '0.5px solid var(--border-subtle)' : 'none', fontSize: 12.5 }}>
              <Icon name="doc" size={12} />
              <span style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{u.name}</span>
              {u.status === 'saved'
                ? <span style={{ fontSize: 11.5, color: 'oklch(0.45 0.13 155)', display: 'flex', alignItems: 'center', gap: 3 }}><Icon name="check" size={11} /> Added</span>
                : u.status === 'error'
                  ? <span title={u.error} style={{ fontSize: 11.5, color: danger, maxWidth: 320, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{u.error}</span>
                  : <span style={{ fontSize: 11.5, color: 'var(--fg-muted)', animation: 'pulse 1.6s ease-in-out infinite' }}>{u.status === 'preparing' ? 'Preparing…' : 'Reading…'}</span>}
            </div>
          ))}
          {!busy && (
            <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginTop: 6, paddingTop: 8, borderTop: '0.5px solid var(--border-subtle)' }}>
              <TaskStatus kind="resume_merge" running="Updating your master resume" />
              {mergeDone && <button className="btn-primary" onClick={onOpenMaster}><Icon name="sparkle" size={12} /> See your master resume</button>}
              <button className="btn-secondary" style={{ marginLeft: 'auto' }} onClick={clear}>Clear list</button>
            </div>
          )}
        </div>
      )}

      <div>
        <button type="button" className="btn-secondary" style={{ fontSize: 11.5 }} onClick={() => setShowManual(!showManual)}>
          {showManual ? 'Hide' : 'No computer connected? Paste from ChatGPT, Claude or Gemini instead'}
        </button>
      </div>
      {showManual && manual}
    </div>
  )
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
    save({ ...master, entries: master.entries.flatMap((e) => { if (e.id !== id) return [e]; const next = fn(e); return next ? [next] : [] }) })
  const editBullet = (entryId: string, bulletId: string, fn: (b: Bullet) => Bullet | null) =>
    editEntry(entryId, (e) => ({ ...e, bullets: e.bullets.flatMap((b) => { if (b.id !== bulletId) return [b]; const next = fn(b); return next ? [next] : [] }) }))
  const sourceName = (id: string) => (id === 'edited' ? 'your edit' : master.sources.find((s) => s.id === id)?.name ?? 'an upload')
  const b = master.basic
  const setBasic = (k: string) => (v: string) => save({ ...master, basic: { ...master.basic, [k]: v } })
  const editEdu = (i: number, patch: Partial<MasterEducation>) => save({ ...master, education: master.education.map((e, j) => (j === i ? { ...e, ...patch } : e)) })

  return (
    <>
      <div style={{ ...card, padding: 12, display: 'flex', flexDirection: 'column', gap: 8 }}>
        <div style={{ fontSize: 14, fontWeight: 600 }}><EditableText label="name" value={b.name} placeholder="Your name" onSave={setBasic('name')} /></div>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(170px, 1fr))', gap: 8, fontSize: 12.5 }}>
          {(['email', 'phone', 'location', 'linkedin', 'github', 'portfolio'] as const).map((k) => (
            <div key={k} style={{ minWidth: 0, overflowWrap: 'anywhere' }}>
              <div style={{ fontSize: 10.5, color: 'var(--fg-muted)', textTransform: 'capitalize' }}>{k}</div>
              <EditableText label={k} value={b[k]} placeholder="Add" onSave={setBasic(k)} />
            </div>
          ))}
        </div>
      </div>

      {(['experience', 'internship', 'project'] as const).map((kind) => {
        const entries = master.entries.filter((e) => e.kind === kind)
        return (
          <div key={kind} style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            <div style={{ display: 'flex', alignItems: 'center' }}>
              <div style={{ fontSize: 11, fontWeight: 600, color: 'var(--fg-muted)', textTransform: 'uppercase', letterSpacing: '0.05em' }}>{KIND_LABEL[kind]}</div>
              <AddInline label={kind === 'project' ? 'Add project' : kind === 'internship' ? 'Add internship' : 'Add job'}
                placeholder={kind === 'project' ? 'Project name' : 'Company'}
                onAdd={(org) => save({ ...master, entries: [...master.entries, {
                  id: newId(), kind, org, title: '', location: '', start_date: '', end_date: '', current: false, link: '', bullets: [], from: ['edited'],
                }] })} />
            </div>
            {entries.map((e) => (
              <div key={e.id} style={{ ...card, padding: 12 }}>
                <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, flexWrap: 'wrap' }}>
                  <span style={{ fontSize: 13, fontWeight: 600 }}><EditableText label="organization" value={e.org} placeholder={kind === 'project' ? 'Project' : 'Company'} onSave={(org) => (org || e.title) && editEntry(e.id, (x) => ({ ...x, org }))} /></span>
                  <span style={{ fontSize: 12.5 }}><EditableText label="title" value={e.title} placeholder={kind === 'project' ? 'Your role' : 'Title'} onSave={(title) => editEntry(e.id, (x) => ({ ...x, title }))} /></span>
                  <span style={{ fontSize: 11.5, color: 'var(--fg-muted)' }}><EditableText label="location" value={e.location} placeholder="location" onSave={(location) => editEntry(e.id, (x) => ({ ...x, location }))} /></span>
                  <span style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 6, fontSize: 11.5, color: 'var(--fg-muted)', whiteSpace: 'nowrap' }}>
                    <EditableText label="start date" value={e.start_date} placeholder="start" onSave={(start_date) => editEntry(e.id, (x) => ({ ...x, start_date }))} />
                    –
                    <EditableText label="end date" value={e.current ? 'now' : e.end_date} placeholder="end" onSave={(end) => editEntry(e.id, (x) => ({ ...x, end_date: /^(now|present|至今)$/i.test(end) ? '' : end, current: /^(now|present|至今)$/i.test(end) }))} />
                    <button className="icon-btn" title="Remove from the master" aria-label="Remove from the master"
                      onClick={() => confirm(`Remove ${e.org || e.title} from your master resume?`) && editEntry(e.id, () => null)}
                      style={{ background: 'transparent', border: 'none', color: 'var(--fg-muted)', cursor: 'pointer', padding: 2, display: 'flex' }}>
                      <Icon name="x" size={12} />
                    </button>
                  </span>
                </div>
                <div style={{ marginTop: 8, display: 'flex', flexDirection: 'column', gap: 6 }}>
                  {e.bullets.map((bullet) => (
                    <BulletRow key={bullet.id} bullet={bullet} sourceName={sourceName}
                      onPrefer={(i) => editBullet(e.id, bullet.id, (y) => ({ ...y, preferred: i }))}
                      onEdit={(text) => editBullet(e.id, bullet.id, (y) => (text
                        ? { ...y, variants: y.variants.map((v, i) => (i === y.preferred ? { ...v, text } : v)) }
                        : null))}
                      onRemoveVariant={(i) => editBullet(e.id, bullet.id, (y) => (y.variants.length < 2 ? null : {
                        ...y, variants: y.variants.filter((_, j) => j !== i), preferred: i < y.preferred ? y.preferred - 1 : i === y.preferred ? 0 : y.preferred,
                      }))}
                      onRemove={() => editBullet(e.id, bullet.id, () => null)} />
                  ))}
                  <div>
                    <AddInline label="Add bullet" placeholder="What you did — one achievement"
                      onAdd={(text) => editEntry(e.id, (x) => ({ ...x, bullets: [...x.bullets, { id: newId(), variants: [{ text, from: ['edited'] }], preferred: 0, skills: [] }] }))} />
                  </div>
                </div>
              </div>
            ))}
          </div>
        )
      })}

      <div style={{ ...card, padding: 12, display: 'flex', flexDirection: 'column', gap: 6 }}>
        <div style={{ display: 'flex', alignItems: 'center' }}>
          <div style={{ fontSize: 11, fontWeight: 600, color: 'var(--fg-muted)', textTransform: 'uppercase', letterSpacing: '0.05em' }}>Education</div>
          <AddInline label="Add school" placeholder="School" onAdd={(school) => save({ ...master, education: [...master.education, {
            school, degree: '', major: '', gpa: '', start_date: '', end_date: '', location: '', description: '',
          }] })} />
        </div>
        {master.education.map((ed, i) => (
          <div key={i} style={{ fontSize: 12.5, display: 'flex', gap: 8, alignItems: 'baseline', flexWrap: 'wrap' }}>
            <b style={{ fontWeight: 500 }}><EditableText label="school" value={ed.school} placeholder="School" onSave={(school) => editEdu(i, { school })} /></b>
            <EditableText label="degree" value={ed.degree} placeholder="Degree" onSave={(degree) => editEdu(i, { degree })} />
            <EditableText label="major" value={ed.major} placeholder="Major" onSave={(major) => editEdu(i, { major })} />
            <span style={{ color: 'var(--fg-muted)', fontSize: 11.5 }}>GPA <EditableText label="GPA" value={ed.gpa} placeholder="—" onSave={(gpa) => editEdu(i, { gpa })} /></span>
            <span style={{ marginLeft: 'auto', color: 'var(--fg-muted)', fontSize: 11.5, display: 'flex', gap: 4, alignItems: 'center' }}>
              <EditableText label="start date" value={ed.start_date} placeholder="start" onSave={(start_date) => editEdu(i, { start_date })} />
              –
              <EditableText label="end date" value={ed.end_date} placeholder="end" onSave={(end_date) => editEdu(i, { end_date })} />
              <button className="icon-btn" title="Remove this school" aria-label="Remove this school"
                onClick={() => save({ ...master, education: master.education.filter((_, j) => j !== i) })}
                style={{ background: 'transparent', border: 'none', color: 'var(--fg-muted)', cursor: 'pointer', padding: 2, display: 'flex' }}>
                <Icon name="x" size={11} />
              </button>
            </span>
          </div>
        ))}
      </div>

      <div style={{ ...card, padding: 12, display: 'flex', flexDirection: 'column', gap: 8, fontSize: 12.5 }}>
        <div>
          <div style={{ fontSize: 10.5, color: 'var(--fg-muted)' }}>Skills</div>
          <EditableList label="skills" items={master.skills} placeholder="Comma-separated, e.g. SQL, Python, Figma" onSave={(skills) => save({ ...master, skills })} />
        </div>
        <div>
          <div style={{ fontSize: 10.5, color: 'var(--fg-muted)' }}>Languages</div>
          <EditableList label="languages" items={master.languages} placeholder="e.g. English, 中文" onSave={(languages) => save({ ...master, languages })} />
        </div>
      </div>
      {update.error && <div role="alert" style={{ ...muted, color: danger }}>{(update.error as Error).message}</div>}
    </>
  )
}

const newId = () => `m${crypto.randomUUID().slice(0, 8)}`

/** "+ Add …" that turns into a one-line field; Enter adds, Esc cancels. */
function AddInline({ label, placeholder, onAdd }: { label: string; placeholder: string; onAdd: (text: string) => void }) {
  const [open, setOpen] = useState(false)
  const [text, setText] = useState('')
  const done = (add: boolean) => {
    if (add && text.trim()) onAdd(text.trim())
    setText('')
    setOpen(false)
  }
  if (!open) {
    return (
      <button type="button" className="btn-secondary" onClick={() => setOpen(true)} style={{ marginLeft: 'auto', fontSize: 11, padding: '2px 8px' }}>
        <Icon name="plus" size={11} /> {label}
      </button>
    )
  }
  return (
    <input autoFocus value={text} placeholder={placeholder} aria-label={label}
      onChange={(e) => setText(e.target.value)}
      onBlur={() => done(true)}
      onKeyDown={(e) => {
        if (e.key === 'Enter' && !e.nativeEvent.isComposing) { e.preventDefault(); done(true) }
        if (e.key === 'Escape') { e.preventDefault(); done(false) }
      }}
      style={{ marginLeft: 'auto', flex: 1, maxWidth: 420, fontSize: 12.5, padding: '3px 8px', fontFamily: 'inherit', border: '1px solid var(--accent)', borderRadius: 5 }} />
  )
}

function BulletRow({ bullet, sourceName, onPrefer, onEdit, onRemoveVariant, onRemove }: {
  bullet: Bullet
  sourceName: (id: string) => string
  onPrefer: (i: number) => void
  onEdit: (text: string) => void
  onRemoveVariant: (i: number) => void
  onRemove: () => void
}) {
  const [open, setOpen] = useState(false)
  const alternatives = bullet.variants.length - 1
  return (
    <div style={{ fontSize: 12.5, lineHeight: 1.5 }}>
      <div style={{ display: 'flex', gap: 6, alignItems: 'flex-start' }}>
        <span style={{ color: 'var(--fg-muted)' }}>•</span>
        <span style={{ flex: 1, minWidth: 0 }}>
          <EditableText label="bullet" value={bullet.variants[bullet.preferred]?.text} placeholder="Bullet" onSave={onEdit} />
        </span>
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
            <div key={i} style={{ display: 'flex', gap: 6, alignItems: 'flex-start', fontSize: 12 }}>
              <input type="radio" aria-label="Use this phrasing" checked={i === bullet.preferred} onChange={() => onPrefer(i)} style={{ marginTop: 3, cursor: 'pointer' }} />
              <span style={{ flex: 1 }}>
                {v.text}
                <span style={{ color: 'var(--fg-muted)', fontSize: 11 }}> — from {v.from.map(sourceName).join(', ') || 'an upload'}</span>
              </span>
              <button type="button" className="icon-btn" title="Drop this phrasing" aria-label="Drop this phrasing" onClick={() => onRemoveVariant(i)}
                style={{ flexShrink: 0, background: 'transparent', border: 'none', color: 'var(--fg-muted)', cursor: 'pointer', padding: 1, display: 'flex' }}>
                <Icon name="x" size={10} />
              </button>
            </div>
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

/** A tailored version's one-page PDF (lib/resume-pdf.ts): what the extension
 *  uploads for this job, or why there isn't one. Made in the browser each
 *  time the version changes; never stored. */
export function VersionPdfCard({ resume }: { resume: DbResume }) {
  const [pdf, setPdf] = useState<ResumePdf | null>(null)
  useEffect(() => {
    let cancelled = false
    setPdf(null)
    void (async () => {
      const [{ makeResumePdf }, { normalizeResume }] = await Promise.all([import('../lib/resume-pdf'), import('@landed/schema')])
      let made: ResumePdf
      try {
        made = await makeResumePdf(normalizeResume(resume.parsed_json))
      } catch {
        made = { ok: false, reason: 'empty' }
      }
      if (!cancelled) setPdf(made)
    })()
    return () => { cancelled = true }
  }, [resume.parsed_json])

  const download = () => {
    if (!pdf?.ok) return
    const url = URL.createObjectURL(new Blob([pdf.bytes.slice()], { type: 'application/pdf' }))
    const a = document.createElement('a')
    a.href = url
    a.download = pdf.name
    a.click()
    setTimeout(() => URL.revokeObjectURL(url), 1000)
  }

  if (pdf && !pdf.ok && pdf.reason === 'empty') return null
  return (
    <div style={{ ...card, padding: 12, maxWidth: 760, display: 'flex', alignItems: 'center', gap: 12 }}>
      <Icon name="doc" size={14} />
      <div style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: 2 }}>
        <div style={{ fontSize: 12.5, fontWeight: 500 }}>
          {!pdf ? 'Making the PDF…' : pdf.ok ? `One-page PDF · ${pdf.name}` : pdf.reason === 'too_long' ? 'Too long for one page' : 'No PDF for this version yet'}
        </div>
        {pdf && (
          <div style={muted}>
            {pdf.ok
              ? 'When the extension fills an application with this version, this PDF goes into the resume upload.'
              : pdf.reason === 'too_long'
                ? `About ${pdf.overLines} line${pdf.overLines === 1 ? '' : 's'} too many. Shorten it below (fewer or shorter bullets) and the PDF is made again; until then the extension uploads your resume file.`
                : `The PDF can't show Chinese, Japanese or Korean text yet (like “${pdf.reason === 'characters' ? pdf.sample : ''}”), so the extension uploads your resume file for this job.`}
          </div>
        )}
      </div>
      {pdf?.ok && (
        <button type="button" className="btn-secondary" onClick={download} style={{ flexShrink: 0 }}>
          <Icon name="download" size={12} /> Download
        </button>
      )}
    </div>
  )
}
