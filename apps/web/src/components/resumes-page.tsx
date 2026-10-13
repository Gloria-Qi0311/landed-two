// Resumes module — issue #20.
//
// One page, three modes:
//   1. **Empty state** (no resumes yet): big "Add your first resume" CTA
//      that opens the upload flow.
//   2. **Upload flow** (when no resume is selected): 3 steps — name +
//      generate prompt + launch AI; paste-back textarea + parse; preview
//      + save.
//   3. **View mode** (when a saved resume is selected): pretty display of
//      the parsed_json sections + actions: set-as-current, replace from
//      JSON, delete.
//
// Per-section inline editing is intentionally deferred to a follow-up —
// gets the loop's pace + keeps this PR reviewable. "Replace from JSON"
// (re-paste the whole thing) is the v1 mutation path.
import React, { useState, useMemo } from 'react'
import { useSearchParams } from 'react-router-dom'
import {
  generatePrompt,
  launchAI,
  tryParseResponse,
  PROVIDERS,
  type Provider,
} from '@landed/ai-roundtrip'
import { ResumeSchema, emptyResume, safeNormalize, isResumeFilled, type Resume } from '@landed/schema'
import { masterStats } from '@landed/schema/master-resume'
import { PageHeader } from './shell'
import { MasterPane, NewVersionPane, UploadPane, VersionNotes } from './my-resume'
import { ResumeEditor } from './resume-editor'
import { Icon } from './primitives'
import {
  useResumes,
  useResumeGroups,
  useAddResume,
  useDeleteResume,
  useSetCurrentResume,
  useUpdateResume,
  type ResumeRow,
} from '../hooks/resumes'

export function ResumesPage() {
  // ?tailor=<application id> (from an application's "Tailor resume")
  const [params, setParams] = useSearchParams()
  const tailorFor = params.get('tailor')
  const resumesQuery = useResumes()
  const addResume = useAddResume()
  const deleteResume = useDeleteResume()
  const setCurrent = useSetCurrentResume()
  const updateResume = useUpdateResume()
  const { master, versions, sources } = useResumeGroups()

  const resumes = resumesQuery.data ?? []
  // 'master' | 'new-version' | 'new' (upload) | a resume id
  const [activeId, setActiveId] = useState<string | null>(tailorFor ? 'new-version' : null)

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
            <button className="btn-secondary" onClick={() => setActiveId('new')}>
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
            <NewVersionPane
              prefillApplicationId={tailorFor}
              onCreated={(id) => { setActiveId(id); if (tailorFor) setParams({}, { replace: true }) }}
              onOpenMaster={() => setActiveId('master')}
            />
          ) : effectiveActiveId === 'new' || activeResume === null ? (
            <UploadPane
              onOpenMaster={() => setActiveId('master')}
              manual={
                <UploadFlow
                  onSave={async (name, parsed, setCurrent) => {
                    const created = await addResume.mutateAsync({ name, parsed, setCurrent })
                    setActiveId(created.id)
                  }}
                />
              }
            />
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
              {activeResume.kind === 'version' && <VersionNotes resume={activeResume} />}
              <ResumeView
                resume={activeResume}
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
// Upload flow — generate prompt → launch AI → paste-back → parse → save
// ──────────────────────────────────────────────────────────────────────────

function UploadFlow({
  onSave,
}: {
  onSave: (name: string, parsed: Resume, setCurrent: boolean) => Promise<void>
}) {
  const [name, setName] = useState(`Resume — ${new Date().toLocaleDateString()}`)
  const [setCurrent, setSetCurrent] = useState(true)
  const [rawResponse, setRawResponse] = useState('')
  const [parsed, setParsed] = useState<Resume | null>(null)
  const [parseError, setParseError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const [launchError, setLaunchError] = useState<string | null>(null)
  // Translation controls. Default: auto-detect source, output English.
  // Common case (English resume → English output) stays auto + en, which the
  // prompt template handles efficiently — the auto-detect branch still runs
  // a no-op when languages match.
  const [sourceLang, setSourceLang] = useState<'auto' | 'en' | 'zh-CN' | 'zh-TW' | 'ja'>('auto')
  const [targetLang, setTargetLang] = useState<'en' | 'zh-CN' | 'zh-TW' | 'ja'>('en')

  const prompt = useMemo(
    () => generatePrompt('resume_parse', { sourceLang, targetLang }),
    [sourceLang, targetLang],
  )

  const onLaunch = async (provider: Provider) => {
    setLaunchError(null)
    const r = await launchAI(provider, prompt)
    if (!r.ok) setLaunchError(r.reason)
  }

  const onPaste = (text: string) => {
    setRawResponse(text)
    setParseError(null)
    if (!text.trim()) {
      setParsed(null)
      return
    }
    const parseResult = tryParseResponse<Resume>(text, ResumeSchema)
    if (!parseResult.ok) {
      setParseError(parseResult.error)
      setParsed(null)
      return
    }
    // Validate with safeNormalize even if parser said ok (schema fill-defaults)
    const normalized = safeNormalize(parseResult.parsed)
    if (!normalized.ok) {
      setParseError('Parsed JSON but fields are off — try asking the model to use the exact schema, or fix manually.')
      setParsed(null)
      return
    }
    setParsed(normalized.resume)
  }

  const onSubmit = async () => {
    if (!parsed) return
    setSaving(true)
    try {
      await onSave(name.trim() || 'Untitled resume', parsed, setCurrent)
    } finally {
      setSaving(false)
    }
  }

  return (
    <div style={{ maxWidth: 760, display: 'flex', flexDirection: 'column', gap: 18 }}>
      <div>
        <div style={{ fontSize: 17, fontWeight: 600, color: 'var(--fg)', fontFamily: 'var(--font-display)', letterSpacing: '-0.01em' }}>
          Add a resume
        </div>
        <div style={{ fontSize: 12.5, color: 'var(--fg-muted)', marginTop: 4, lineHeight: 1.55 }}>
          Three steps. We don't run an AI for you — we just give you the prompt
          and let you paste the reply back here. Your subscription, your token budget.
        </div>
      </div>

      {/* Step 1: name */}
      <Section number={1} title="Name this resume">
        <input
          type="text"
          value={name}
          onChange={(e) => setName(e.target.value)}
          style={{ width: 360, padding: '7px 10px', fontSize: 12.5 }}
          placeholder="e.g. Antares — May 2026"
        />
      </Section>

      {/* Step 2: language */}
      <Section number={2} title="Languages (translate if they differ)">
        <div style={{ fontSize: 11.5, color: 'var(--fg-muted)', marginBottom: 8, lineHeight: 1.5 }}>
          Defaults are auto-detect → English. Pick a different target if you want the parsed
          fields in another language. Proper nouns (companies, schools, technologies) stay in
          the original.
        </div>
        <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap', alignItems: 'center' }}>
          <label style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
            <span style={{ fontSize: 10.5, fontWeight: 600, color: 'var(--fg-muted)', textTransform: 'uppercase', letterSpacing: '0.06em' }}>
              Source (your resume)
            </span>
            <select
              value={sourceLang}
              onChange={(e) => setSourceLang(e.target.value as typeof sourceLang)}
              style={{ padding: '6px 8px', fontSize: 12.5, minWidth: 180 }}
            >
              <option value="auto">Auto-detect</option>
              <option value="en">English</option>
              <option value="zh-CN">中文 (简体)</option>
              <option value="zh-TW">中文 (繁體)</option>
              <option value="ja">日本語</option>
            </select>
          </label>
          <span style={{ fontSize: 16, color: 'var(--fg-muted)', alignSelf: 'flex-end', paddingBottom: 6 }}>→</span>
          <label style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
            <span style={{ fontSize: 10.5, fontWeight: 600, color: 'var(--fg-muted)', textTransform: 'uppercase', letterSpacing: '0.06em' }}>
              Target (parsed output)
            </span>
            <select
              value={targetLang}
              onChange={(e) => setTargetLang(e.target.value as typeof targetLang)}
              style={{ padding: '6px 8px', fontSize: 12.5, minWidth: 180 }}
            >
              <option value="en">English</option>
              <option value="zh-CN">中文 (简体)</option>
              <option value="zh-TW">中文 (繁體)</option>
              <option value="ja">日本語</option>
            </select>
          </label>
        </div>
      </Section>

      {/* Step 3: launch */}
      <Section number={3} title="Send the prompt to your AI of choice">
        <div style={{ fontSize: 11.5, color: 'var(--fg-muted)', marginBottom: 8, lineHeight: 1.5 }}>
          We'll copy the prompt to your clipboard and open the AI in a new tab.
          Upload your PDF there. Paste the AI's JSON reply back here when ready.
        </div>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          {(['chatgpt', 'claude', 'gemini'] as const).map((p) => (
            <button key={p} onClick={() => onLaunch(p)} className="btn-secondary">
              <Icon name="external" size={12} /> Launch {PROVIDERS[p].label}
            </button>
          ))}
        </div>
        {launchError && (
          <div style={{ fontSize: 11.5, color: 'oklch(0.45 0.15 30)', marginTop: 8, padding: '6px 10px', background: 'oklch(0.97 0.03 30)', border: '0.5px solid oklch(0.88 0.06 30)', borderRadius: 6 }}>
            {launchError}
          </div>
        )}
        <details style={{ marginTop: 10 }}>
          <summary style={{ fontSize: 11.5, color: 'var(--fg-muted)', cursor: 'pointer' }}>
            Show / copy prompt manually
          </summary>
          <textarea
            readOnly
            value={prompt}
            style={{ width: '100%', minHeight: 140, marginTop: 8, padding: 10, fontSize: 11.5, fontFamily: 'var(--font-mono)', resize: 'vertical' }}
          />
        </details>
      </Section>

      {/* Step 3: paste */}
      <Section number={4} title="Paste the AI's JSON reply">
        <textarea
          value={rawResponse}
          onChange={(e) => onPaste(e.target.value)}
          placeholder={'{\n  "version": 2,\n  "basic": { "name": "..." },\n  ...\n}'}
          style={{ width: '100%', minHeight: 200, padding: 10, fontSize: 11.5, fontFamily: 'var(--font-mono)', resize: 'vertical' }}
        />
        {parseError && (
          <div style={{ fontSize: 11.5, color: 'oklch(0.45 0.15 30)', marginTop: 8, padding: '6px 10px', background: 'oklch(0.97 0.03 30)', border: '0.5px solid oklch(0.88 0.06 30)', borderRadius: 6 }}>
            {parseError}
          </div>
        )}
        {parsed && (
          <div style={{ marginTop: 12, padding: 12, background: 'var(--surface-2)', border: '0.5px solid var(--border)', borderRadius: 8 }}>
            <div style={{ fontSize: 11, fontWeight: 600, color: 'var(--fg-muted)', textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: 8 }}>
              Preview
            </div>
            <ResumeSummary resume={parsed} />
          </div>
        )}
      </Section>

      {/* Save */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, paddingTop: 4 }}>
        <label style={{ fontSize: 12, color: 'var(--fg)', display: 'flex', alignItems: 'center', gap: 6 }}>
          <input type="checkbox" checked={setCurrent} onChange={(e) => setSetCurrent(e.target.checked)} />
          Mark as current resume
        </label>
        <div style={{ flex: 1 }} />
        <button
          onClick={onSubmit}
          disabled={!parsed || saving}
          className="btn-primary"
          style={{ opacity: !parsed || saving ? 0.5 : 1 }}
        >
          {saving ? 'Saving…' : 'Save resume'}
          {!saving && <Icon name="arrowRight" size={12} />}
        </button>
      </div>
    </div>
  )
}

// ──────────────────────────────────────────────────────────────────────────
// View mode — pretty display + actions
// ──────────────────────────────────────────────────────────────────────────

function ResumeView({
  resume,
  onReplace,
  onRename,
}: {
  resume: ResumeRow
  onReplace: (parsed: Resume) => Promise<void>
  onRename: (name: string) => Promise<void>
}) {
  const [renaming, setRenaming] = useState(false)
  const [newName, setNewName] = useState(resume.name)
  const [replacing, setReplacing] = useState(false)
  const [rawReplace, setRawReplace] = useState('')
  const [replaceError, setReplaceError] = useState<string | null>(null)

  const parsed = resume.parsed_json
  const filled = parsed ? isResumeFilled(parsed) : false

  const submitReplace = async () => {
    setReplaceError(null)
    const parseResult = tryParseResponse<Resume>(rawReplace, ResumeSchema)
    if (!parseResult.ok) {
      setReplaceError(parseResult.error)
      return
    }
    const normalized = safeNormalize(parseResult.parsed)
    if (!normalized.ok) {
      setReplaceError('Parsed but shape is off.')
      return
    }
    await onReplace(normalized.resume)
    setReplacing(false)
    setRawReplace('')
  }

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
            <button className="btn-secondary" onClick={() => setReplacing(true)} style={{ fontSize: 11.5, padding: '3px 8px' }}>
              <Icon name="refresh" size={11} /> Replace from JSON
            </button>
          </>
        )}
      </div>

      {replacing && (
        <div style={{ padding: 12, background: 'var(--surface-2)', border: '0.5px solid var(--border)', borderRadius: 8 }}>
          <div style={{ fontSize: 11.5, color: 'var(--fg-muted)', marginBottom: 8 }}>
            Paste a new parsed JSON to replace this resume's contents. Schema and version must match.
          </div>
          <textarea
            value={rawReplace}
            onChange={(e) => setRawReplace(e.target.value)}
            placeholder='{"version": 2, "basic": {...}, ...}'
            style={{ width: '100%', minHeight: 160, padding: 10, fontSize: 11.5, fontFamily: 'var(--font-mono)', resize: 'vertical' }}
          />
          {replaceError && (
            <div style={{ fontSize: 11.5, color: 'oklch(0.45 0.15 30)', marginTop: 8 }}>{replaceError}</div>
          )}
          <div style={{ marginTop: 10, display: 'flex', gap: 8 }}>
            <button className="btn-primary" onClick={submitReplace}>Save replacement</button>
            <button className="btn-secondary" onClick={() => { setReplacing(false); setRawReplace(''); setReplaceError(null) }}>Cancel</button>
          </div>
        </div>
      )}

      {!filled && (
        <div style={{ fontSize: 12, color: 'var(--fg-muted)', padding: 12, background: 'var(--surface-2)', border: '0.5px dashed var(--border)', borderRadius: 8 }}>
          This resume is empty. Click any field below to fill it in.
        </div>
      )}

      {/* Click any text to edit it; saved as you go. */}
      <ResumeEditor resume={parsed ?? emptyResume()} onChange={(next) => void onReplace(next)} />
    </div>
  )
}

// ──────────────────────────────────────────────────────────────────────────
// Display helpers
// ──────────────────────────────────────────────────────────────────────────

function ResumeSummary({ resume }: { resume: Resume }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
      {/* Basic */}
      <PreviewBlock label="Basic">
        <div style={{ fontSize: 12, color: 'var(--fg)' }}>
          {resume.basic.name || resume.basic.englishName || '(unnamed)'}
          {resume.basic.chineseName && resume.basic.chineseName !== resume.basic.name && (
            <span style={{ marginLeft: 8, color: 'var(--fg-muted)' }}>{resume.basic.chineseName}</span>
          )}
        </div>
        <KvRow>
          {resume.basic.email && <Kv k="Email" v={resume.basic.email} />}
          {resume.basic.phone && <Kv k="Phone" v={resume.basic.phone} />}
          {resume.basic.location && <Kv k="Location" v={resume.basic.location} />}
          {resume.basic.linkedin && <Kv k="LinkedIn" v={resume.basic.linkedin} />}
          {resume.basic.github && <Kv k="GitHub" v={resume.basic.github} />}
          {resume.basic.portfolio && <Kv k="Portfolio" v={resume.basic.portfolio} />}
        </KvRow>
      </PreviewBlock>

      {/* Intent */}
      {(resume.intent.apply_position || resume.intent.salary || resume.intent.years_exp) && (
        <PreviewBlock label="Intent">
          <KvRow>
            {resume.intent.apply_position && <Kv k="Target role" v={resume.intent.apply_position} />}
            {resume.intent.years_exp && <Kv k="Years experience" v={resume.intent.years_exp} />}
            {resume.intent.salary && <Kv k="Expected salary" v={resume.intent.salary} />}
            {resume.intent.available_date && <Kv k="Available" v={resume.intent.available_date} />}
          </KvRow>
        </PreviewBlock>
      )}

      {/* Experience */}
      {resume.experience.length > 0 && (
        <PreviewBlock label={`Experience (${resume.experience.length})`}>
          <EntryList entries={resume.experience} kind="experience" />
        </PreviewBlock>
      )}

      {/* Internship */}
      {resume.internship.length > 0 && (
        <PreviewBlock label={`Internship (${resume.internship.length})`}>
          <EntryList entries={resume.internship} kind="experience" />
        </PreviewBlock>
      )}

      {/* Education */}
      {resume.education.length > 0 && (
        <PreviewBlock label={`Education (${resume.education.length})`}>
          <EntryList entries={resume.education} kind="education" />
        </PreviewBlock>
      )}

      {/* Projects */}
      {resume.projects.length > 0 && (
        <PreviewBlock label={`Projects (${resume.projects.length})`}>
          <EntryList entries={resume.projects} kind="project" />
        </PreviewBlock>
      )}

      {/* Skills + Languages */}
      {(resume.skills.length > 0 || resume.languages.length > 0) && (
        <PreviewBlock label="Skills & languages">
          {resume.skills.length > 0 && (
            <ChipRow label="Skills" items={resume.skills} />
          )}
          {resume.languages.length > 0 && (
            <ChipRow label="Languages" items={resume.languages} />
          )}
        </PreviewBlock>
      )}

      {/* Summary */}
      {resume.summary && (
        <PreviewBlock label="Summary">
          <div style={{ fontSize: 12.5, color: 'var(--fg)', lineHeight: 1.55, whiteSpace: 'pre-wrap' }}>
            {resume.summary}
          </div>
        </PreviewBlock>
      )}
    </div>
  )
}

function Section({ number, title, children }: { number: number; title: string; children: React.ReactNode }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <span style={{ width: 22, height: 22, borderRadius: 11, background: 'var(--surface-3)', color: 'var(--fg-muted)', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 11.5, fontWeight: 600, fontVariantNumeric: 'tabular-nums' }}>
          {number}
        </span>
        <span style={{ fontSize: 13, fontWeight: 600, color: 'var(--fg)' }}>{title}</span>
      </div>
      <div style={{ paddingLeft: 30 }}>{children}</div>
    </div>
  )
}

function PreviewBlock({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <div style={{ fontSize: 10.5, fontWeight: 600, color: 'var(--fg-muted)', textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: 6 }}>
        {label}
      </div>
      {children}
    </div>
  )
}

function KvRow({ children }: { children: React.ReactNode }) {
  return (
    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 14, marginTop: 4 }}>
      {children}
    </div>
  )
}

function Kv({ k, v }: { k: string; v: string }) {
  return (
    <div>
      <div style={{ fontSize: 10, color: 'var(--fg-muted)', textTransform: 'uppercase', letterSpacing: '0.05em' }}>{k}</div>
      <div style={{ fontSize: 12, color: 'var(--fg)', fontVariantNumeric: 'tabular-nums' }}>{v}</div>
    </div>
  )
}

function EntryList({ entries, kind }: { entries: any[]; kind: 'experience' | 'education' | 'project' }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
      {entries.map((e, i) => (
        <div key={i} style={{ padding: 10, background: 'var(--surface)', border: '0.5px solid var(--border)', borderRadius: 6 }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', gap: 8 }}>
            <div style={{ fontSize: 12.5, fontWeight: 600, color: 'var(--fg)' }}>
              {kind === 'education' ? (e.school || e.major || '(unnamed)') : kind === 'project' ? (e.name || '(unnamed)') : (e.company || '(unnamed)')}
            </div>
            <div style={{ fontSize: 10.5, color: 'var(--fg-muted)', fontFamily: 'var(--font-mono)' }}>
              {e.start_date}{e.start_date && (e.end_date || e.current) && ' – '}{e.end_date || (e.current ? 'present' : '')}
            </div>
          </div>
          <div style={{ fontSize: 11.5, color: 'var(--fg-muted)', marginTop: 2 }}>
            {kind === 'education' ? [e.degree, e.major, e.gpa && `GPA ${e.gpa}`].filter(Boolean).join(' · ') :
             kind === 'project' ? [e.role, e.link].filter(Boolean).join(' · ') :
             [e.title, e.location].filter(Boolean).join(' · ')}
          </div>
          {e.description && (
            <div style={{ fontSize: 11.5, color: 'var(--fg)', marginTop: 6, lineHeight: 1.5, whiteSpace: 'pre-wrap' }}>
              {e.description}
            </div>
          )}
        </div>
      ))}
    </div>
  )
}

function ChipRow({ label, items }: { label: string; items: string[] }) {
  return (
    <div style={{ marginBottom: 8 }}>
      <div style={{ fontSize: 10.5, color: 'var(--fg-muted)', marginBottom: 4 }}>{label}</div>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4 }}>
        {items.map((it, i) => (
          <span key={i} style={{ fontSize: 11, padding: '2px 7px', background: 'var(--surface-3)', borderRadius: 4, color: 'var(--fg)' }}>
            {it}
          </span>
        ))}
      </div>
    </div>
  )
}
