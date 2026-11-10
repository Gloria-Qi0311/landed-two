// My Resume: the master resume, its tailored versions and the uploads it
// was merged from. Uploads are read by the user's own agent (or, without
// one, only their basics in the browser); every resume is edited in place
// with ResumeEditor.
import { useState, useMemo } from 'react'
import { useNavigate } from 'react-router-dom'
import { useResumeTask } from '../lib/resume-tasks'
import { emptyResume, isResumeFilled, type Resume } from '@landed/schema'
import { masterStats } from '@landed/schema/master-resume'
import { PageHeader } from './shell'
import { DirectionsCard, MasterPane, NewVersionPane, SourceFileCard, UploadPane, VersionNotes, VersionPdfCard } from './my-resume'
import { ResumeEditor } from './resume-editor'
import { Icon } from './primitives'
import {
  useResumes,
  useResumeGroups,
  useDeleteResume,
  useSetCurrentResume,
  useUpdateResume,
  type ResumeRow,
} from '../hooks/resumes'

/** Resumes uploaded without a computer that it's reading in full right now. */
function useReadingIds(): Set<string> {
  const uploads = useResumeTask((s) => s.uploads)
  return new Set(uploads.filter((u) => u.replace_id && (u.status === 'preparing' || u.status === 'reading')).map((u) => u.replace_id!))
}

export function ResumesPage() {
  const reading = useReadingIds()
  const resumesQuery = useResumes()
  const deleteResume = useDeleteResume()
  const setCurrent = useSetCurrentResume()
  const updateResume = useUpdateResume()
  const { master, versions, sources } = useResumeGroups()

  const resumes = resumesQuery.data ?? []
  // 'master' | 'new-version' | 'new' (upload) | a resume id
  const [activeId, setActiveId] = useState<string | null>(null)
  // Set by the header's Upload resume: the upload pane opens the file chooser once.
  const [pick, setPick] = useState(false)

  // Default: the current resume, else the master, else the first upload.
  const effectiveActiveId = useMemo(() => {
    if (activeId === 'new' || activeId === 'new-version' || activeId === 'master') return activeId
    if (activeId && resumes.find((r) => r.id === activeId)) return activeId
    const cur = resumes.find((r) => r.is_current && r.kind !== 'master')
    if (cur) return cur.id
    if (master || sources.length) return 'master'
    return 'new'
  }, [activeId, resumes, master, sources.length])

  const activeResume = resumes.find((r) => r.id === effectiveActiveId) ?? null
  const onDelete = (id: string) => {
    if (confirm('Delete this resume? This cannot be undone.')) {
      deleteResume.mutate(id, { onSuccess: () => { if (effectiveActiveId === id) setActiveId(null) } })
    }
  }

  return (
    <>
      <PageHeader
        title="My Resume"
        subtitle={
          resumesQuery.isLoading
            ? 'Loading…'
            : `${master ? 'Master resume' : 'No master yet'} · ${versions.length} version${versions.length === 1 ? '' : 's'} · ${sources.length} uploaded`
        }
        actions={
          <>
            <button className="btn-secondary" onClick={() => { setActiveId('new'); setPick(true) }}>
              <Icon name="plus" size={13} stroke={2} /> Upload resume
            </button>
            <button className="btn-primary" onClick={() => setActiveId('new-version')}>
              <Icon name="sparkle" size={13} /> New version
            </button>
          </>
        }
      />
      <div style={{ flex: 1, display: 'flex', minHeight: 0 }}>
        <ResumesList
          master={master}
          versions={versions}
          sources={sources}
          activeId={effectiveActiveId}
          onSelect={setActiveId}
          onSetCurrent={(id) => setCurrent.mutate(id)}
          onDelete={onDelete}
        />
        <div style={{ flex: 1, overflowY: 'auto', padding: '16px 28px', minWidth: 0 }}>
          {effectiveActiveId === 'master' ? (
            <MasterPane onUpload={() => setActiveId('new')} />
          ) : effectiveActiveId === 'new-version' ? (
            <NewVersionPane onCreated={setActiveId} onOpenMaster={() => setActiveId('master')} />
          ) : effectiveActiveId === 'new' || activeResume === null ? (
            <UploadPane
              pick={pick}
              onPicked={() => setPick(false)}
              onOpenMaster={() => setActiveId('master')}
            />
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
              {activeResume.kind === 'version' && <VersionNotes resume={activeResume} />}
              {activeResume.kind === 'version' && <VersionPdfCard resume={activeResume} />}
              {activeResume.kind === 'source' && <DirectionsCard resume={activeResume} />}
              {activeResume.kind === 'source' && <SourceFileCard resume={activeResume} />}
              <ResumeView
                resume={activeResume}
                waiting={activeResume.file_path ? (reading.has(activeResume.id) ? 'reading' : 'waiting') : null}
                onReplace={async (parsed) => {
                  await updateResume.mutateAsync({ id: activeResume.id, patch: { parsed_json: parsed } })
                }}
                onRename={async (name) => {
                  await updateResume.mutateAsync({ id: activeResume.id, patch: { name } })
                }}
              />
            </div>
          )}
        </div>
      </div>
    </>
  )
}

// ──────────────────────────────────────────────────────────────────────────
// Left rail — master, versions, uploads
// ──────────────────────────────────────────────────────────────────────────

const railLabel = { fontSize: 10.5, fontWeight: 600, color: 'var(--fg-muted)', textTransform: 'uppercase', letterSpacing: '0.06em', padding: '10px 10px 6px', display: 'flex', alignItems: 'center' } as const

function ResumesList({
  master,
  versions,
  sources,
  activeId,
  onSelect,
  onSetCurrent,
  onDelete,
}: {
  master: ResumeRow | null
  versions: ResumeRow[]
  sources: ResumeRow[]
  activeId: string
  onSelect: (id: string) => void
  onSetCurrent: (id: string) => void
  onDelete: (id: string) => void
}) {
  const reading = useReadingIds()
  const stats = master?.master_json ? masterStats(master.master_json) : null
  return (
    <aside style={{ width: 250, flexShrink: 0, borderRight: '0.5px solid var(--border)', background: 'var(--surface-2)', padding: 10, overflowY: 'auto' }}>
      <div style={railLabel}>Master</div>
      <RailItem
        active={activeId === 'master'}
        icon="sparkle"
        title={master ? 'Master resume' : 'Build your master'}
        subtitle={stats ? `${stats.entries} roles · ${stats.bullets} bullets · ${stats.alternatives} alt. phrasings` : 'Merged from all your uploads'}
        current={!!master?.is_current}
        onClick={() => onSelect('master')}
        actions={master && activeId === 'master' ? { onSetCurrent: master.is_current ? undefined : () => onSetCurrent(master.id), onDelete: () => onDelete(master.id) } : undefined}
      />

      <div style={railLabel}>
        Versions
        <button className="icon-btn" title="New version" aria-label="New version" onClick={() => onSelect('new-version')}
          style={{ marginLeft: 'auto', background: 'transparent', border: 'none', color: 'var(--fg-muted)', cursor: 'pointer', padding: 2, display: 'flex' }}>
          <Icon name="plus" size={12} />
        </button>
      </div>
      {versions.length === 0 && <div style={{ fontSize: 11.5, color: 'var(--fg-muted)', padding: '0 10px 6px', lineHeight: 1.5 }}>One per kind of role you apply to — tailored from your master.</div>}
      {versions.map((r) => (
        <RailItem key={r.id} active={activeId === r.id} icon="target" title={r.name}
          subtitle={r.target_json?.company ?? undefined} current={r.is_current} onClick={() => onSelect(r.id)}
          actions={activeId === r.id ? { onSetCurrent: r.is_current ? undefined : () => onSetCurrent(r.id), onDelete: () => onDelete(r.id) } : undefined} />
      ))}

      <div style={railLabel}>
        Uploaded
        <button className="icon-btn" title="Upload a resume" aria-label="Upload a resume" onClick={() => onSelect('new')}
          style={{ marginLeft: 'auto', background: 'transparent', border: 'none', color: 'var(--fg-muted)', cursor: 'pointer', padding: 2, display: 'flex' }}>
          <Icon name="plus" size={12} />
        </button>
      </div>
      {sources.length === 0 && <div style={{ fontSize: 11.5, color: 'var(--fg-muted)', padding: '0 10px 6px', lineHeight: 1.5 }}>Upload every resume you have — each adds to your master.</div>}
      {sources.map((r) => (
        <RailItem key={r.id} active={activeId === r.id} icon="doc" title={r.name} current={r.is_current} onClick={() => onSelect(r.id)}
          subtitle={r.file_path ? (reading.has(r.id) ? 'Reading the rest…' : 'Waiting for your computer') : undefined}
          actions={activeId === r.id ? { onSetCurrent: r.is_current ? undefined : () => onSetCurrent(r.id), onDelete: () => onDelete(r.id) } : undefined} />
      ))}
    </aside>
  )
}

function RailItem({ active, icon, title, subtitle, current, onClick, actions }: {
  active: boolean
  icon: string
  title: string
  subtitle?: string
  current: boolean
  onClick: () => void
  actions?: { onSetCurrent?: () => void; onDelete: () => void }
}) {
  return (
    <div onClick={onClick} className="sidebar-item" style={{
      padding: '8px 10px', borderRadius: 6, marginBottom: 4, cursor: 'pointer', display: 'flex', flexDirection: 'column', gap: 3,
      background: active ? 'var(--surface)' : 'transparent', border: `0.5px solid ${active ? 'var(--border)' : 'transparent'}`,
    }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
        <Icon name={icon} size={12} />
        <span style={{ fontSize: 12, fontWeight: 500, color: 'var(--fg)', flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{title}</span>
        {current && (
          <span title="Auto-fill uses this one" style={{ fontSize: 9.5, fontWeight: 600, color: 'oklch(0.42 0.13 155)', background: 'oklch(0.96 0.05 155)', padding: '1px 5px', borderRadius: 3, textTransform: 'uppercase', letterSpacing: '0.04em' }}>
            current
          </span>
        )}
      </div>
      {subtitle && <div style={{ fontSize: 10.5, color: 'var(--fg-muted)', paddingLeft: 18, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{subtitle}</div>}
      {actions && (
        <div style={{ display: 'flex', gap: 4, marginTop: 2 }}>
          {actions.onSetCurrent && (
            <button onClick={(e) => { e.stopPropagation(); actions.onSetCurrent!() }} className="btn-secondary" style={{ fontSize: 10.5, padding: '2px 6px' }}
              title="The extension auto-fills applications from the current resume">
              Use for auto-fill
            </button>
          )}
          <button onClick={(e) => { e.stopPropagation(); actions.onDelete() }} className="btn-secondary" style={{ fontSize: 10.5, padding: '2px 6px', color: 'oklch(0.5 0.16 30)' }}>
            Delete
          </button>
        </div>
      )}
    </div>
  )
}

// ──────────────────────────────────────────────────────────────────────────
// View mode — pretty display + actions
// ──────────────────────────────────────────────────────────────────────────

function ResumeView({
  resume,
  waiting,
  onReplace,
  onRename,
}: {
  resume: ResumeRow
  /** uploaded without a computer: still waiting for it, or being read now */
  waiting: 'waiting' | 'reading' | null
  onReplace: (parsed: Resume) => Promise<void>
  onRename: (name: string) => Promise<void>
}) {
  const [renaming, setRenaming] = useState(false)
  const [newName, setNewName] = useState(resume.name)

  const parsed = resume.parsed_json
  const filled = parsed ? isResumeFilled(parsed) : false

  return (
    <div style={{ maxWidth: 760, display: 'flex', flexDirection: 'column', gap: 16 }}>
      {/* Header */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
        {renaming ? (
          <>
            <input
              type="text"
              value={newName}
              onChange={(e) => setNewName(e.target.value)}
              style={{ fontSize: 17, padding: '4px 8px', flex: 1, maxWidth: 360 }}
              autoFocus
            />
            <button
              className="btn-primary"
              onClick={async () => {
                await onRename(newName.trim() || resume.name)
                setRenaming(false)
              }}
            >
              Save
            </button>
            <button className="btn-secondary" onClick={() => { setRenaming(false); setNewName(resume.name) }}>
              Cancel
            </button>
          </>
        ) : (
          <>
            <div style={{ fontSize: 17, fontWeight: 600, color: 'var(--fg)', fontFamily: 'var(--font-display)' }}>
              {resume.name}
            </div>
            {resume.is_current && (
              <span style={{ fontSize: 10, fontWeight: 600, color: 'oklch(0.42 0.13 155)', background: 'oklch(0.96 0.05 155)', padding: '2px 7px', borderRadius: 4, textTransform: 'uppercase', letterSpacing: '0.04em' }}>
                Current
              </span>
            )}
            <button className="btn-secondary" onClick={() => setRenaming(true)} style={{ marginLeft: 'auto', fontSize: 11.5, padding: '3px 8px' }}>
              <Icon name="settings" size={11} /> Rename
            </button>
          </>
        )}
      </div>

      {waiting ? <WaitingNote reading={waiting === 'reading'} /> : !filled && (
        <div style={{ fontSize: 12, color: 'var(--fg-muted)', padding: 12, background: 'var(--surface-2)', border: '0.5px dashed var(--border)', borderRadius: 8 }}>
          This resume is empty. Click any field below to fill it in.
        </div>
      )}

      {/* Click any text to edit it; saved as you go. */}
      <ResumeEditor resume={parsed ?? emptyResume()} onChange={(next) => void onReplace(next)} />
    </div>
  )
}

/** A resume uploaded without a computer: only its basics so far. */
function WaitingNote({ reading }: { reading: boolean }) {
  const navigate = useNavigate()
  return (
    <div role="status" style={{ display: 'flex', alignItems: 'center', gap: 10, fontSize: 12, color: 'var(--fg-muted)', lineHeight: 1.5, padding: '10px 12px', background: 'var(--accent-soft)', borderRadius: 8 }}>
      <span style={{ color: 'var(--accent)', display: 'flex', animation: reading ? 'pulse 1.6s ease-in-out infinite' : undefined }}><Icon name={reading ? 'sparkle' : 'device'} size={14} /></span>
      <span style={{ flex: 1 }}>
        {reading
          ? 'Your computer is reading the rest of this resume: experience, education and skills. It fills in below when done.'
          : "Only the basics so far: name, email, phone and links. Your experience, education and skills are read when your computer is connected; that starts on its own."}
      </span>
      {!reading && <button type="button" className="btn-secondary" onClick={() => navigate('/agent')} style={{ fontSize: 12, flexShrink: 0 }}>Connect your computer</button>}
    </div>
  )
}
