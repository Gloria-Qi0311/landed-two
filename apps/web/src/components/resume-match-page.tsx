// Resume Match page (issue #21).
//
// Picks up the current resume from useCurrentResume(); user adds N JD slots
// (paste title + body, or insert from a saved application). For each
// provider (ChatGPT / Claude / Gemini), the user launches the prompt,
// pastes the AI's reply back, and we render the per-provider rankings
// side-by-side so the user can see where the three AIs agree + disagree.
//
// Replaces the prototype port at src/components/resume-match.jsx, which
// was local-state mockery with no DB / no real launch.
import React, { useMemo, useState } from 'react'
import { z } from 'zod'
import {
  PROVIDERS,
  generatePrompt,
  launchAI,
  tryParseResponse,
  saveAiRun,
  type Provider,
  type ParseFormat,
} from '@landed/ai-roundtrip'
import { PageHeader } from './shell'
import { Icon, CompanyMark } from './primitives'
import { supabase } from '../lib/supabase'
import { useCurrentResume } from '../hooks/resumes'
import { useApplications, useCompanies } from '../hooks/queries'
import { Link } from 'react-router-dom'

// Schema for the per-provider ranking output. Lives inline because it's
// scoped to this page; if JD Breakdown ends up reusing it, lift to
// @landed/schema.
const RankingSchema = z.object({
  jd_id: z.string(),
  rank: z.coerce.number().int().nonnegative(),
  score: z.coerce.number().min(0).max(10),
  reasons: z.array(z.coerce.string()).default([]),
  gaps: z.array(z.coerce.string()).default([]),
})
const RankingsResponseSchema = z.object({
  rankings: z.array(RankingSchema),
})
type Ranking = z.infer<typeof RankingSchema>

type JdSlot = { id: string; title: string; body: string }

type ProviderState =
  | { status: 'idle' }
  | { status: 'awaiting'; prompt: string }
  | { status: 'parsed'; rankings: Ranking[]; raw: string; format: ParseFormat; aiRunId?: string }
  | { status: 'failed'; raw: string; error: string }

const PROVIDER_LIST: Provider[] = ['chatgpt', 'claude', 'gemini']
const initialProviders = (): Record<Provider, ProviderState> => ({
  chatgpt: { status: 'idle' },
  claude: { status: 'idle' },
  gemini: { status: 'idle' },
  other: { status: 'idle' },
})

const newSlot = (): JdSlot => ({
  id: `jd-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
  title: '',
  body: '',
})

export function ResumeMatchPage() {
  const { data: currentResume, isLoading: resumeLoading } = useCurrentResume()
  const { data: apps = [] } = useApplications()
  const { data: companies = [] } = useCompanies()

  const [jds, setJds] = useState<JdSlot[]>([newSlot(), newSlot()])
  const [providers, setProviders] = useState<Record<Provider, ProviderState>>(initialProviders)

  // The prompt the user will send. Memoized so the displayed text only
  // recomputes when inputs change.
  const prompt = useMemo(() => {
    if (!currentResume?.parsed_json) return ''
    return generatePrompt('resume_match', {
      resume: currentResume.parsed_json,
      jds: jds
        .filter((j) => j.title.trim() || j.body.trim())
        .map((j) => ({ id: j.id, title: j.title, body: j.body })),
    })
  }, [currentResume, jds])

  const validJdCount = jds.filter((j) => j.title.trim() || j.body.trim()).length
  const canLaunch = !!currentResume?.parsed_json && validJdCount > 0

  const onLaunch = async (provider: Provider) => {
    if (!canLaunch) return
    const r = await launchAI(provider, prompt)
    if (!r.ok) {
      setProviders((p) => ({ ...p, [provider]: { status: 'failed', raw: '', error: r.reason } }))
      return
    }
    setProviders((p) => ({ ...p, [provider]: { status: 'awaiting', prompt } }))
  }

  // Manual-paste path: card transitions straight to 'awaiting' without
  // re-copying or re-opening the popup.
  const onManualPaste = (provider: Provider) => {
    if (!canLaunch) return
    setProviders((p) =>
      p[provider].status === 'idle' || p[provider].status === 'failed'
        ? { ...p, [provider]: { status: 'awaiting', prompt } }
        : p,
    )
  }

  const onPaste = async (provider: Provider, text: string) => {
    const parseResult = tryParseResponse(text, RankingsResponseSchema)
    if (!parseResult.ok) {
      setProviders((p) => ({ ...p, [provider]: { status: 'failed', raw: text, error: parseResult.error } }))
      // Persist the failed run so retros can see what the AI returned
      saveAiRun(supabase, {
        task: 'resume_match',
        provider,
        prompt,
        response: text,
        parseFormat: 'failed',
      }).catch(() => {})
      return
    }
    const data = parseResult.parsed as any
    const rankings: Ranking[] = Array.isArray(data?.rankings) ? data.rankings : []
    setProviders((p) => ({
      ...p,
      [provider]: { status: 'parsed', rankings, raw: text, format: parseResult.format },
    }))
    // Persist to ai_runs; ignore the returned id beyond logging.
    const save = await saveAiRun(supabase, {
      task: 'resume_match',
      provider,
      prompt,
      response: text,
      parsed: data,
      parseFormat: parseResult.format,
    })
    if (save.ok) {
      setProviders((p) => ({
        ...p,
        [provider]:
          p[provider].status === 'parsed' ? { ...p[provider], aiRunId: save.id } : p[provider],
      }))
    }
  }

  const resetProvider = (provider: Provider) => {
    setProviders((p) => ({ ...p, [provider]: { status: 'idle' } }))
  }

  // ── Render ───────────────────────────────────────────────────────────────

  if (resumeLoading) {
    return (
      <>
        <PageHeader title="Resume Match" subtitle="Loading…" />
      </>
    )
  }

  if (!currentResume?.parsed_json) {
    return (
      <>
        <PageHeader
          title="Resume Match"
          subtitle="You need a current resume before you can match JDs against it"
        />
        <div style={{ padding: 28 }}>
          <div
            style={{
              maxWidth: 540,
              padding: 18,
              background: 'var(--surface-2)',
              border: '0.5px dashed var(--border)',
              borderRadius: 10,
              display: 'flex',
              flexDirection: 'column',
              gap: 10,
            }}
          >
            <div style={{ fontSize: 14, fontWeight: 600, color: 'var(--fg)' }}>
              No current resume
            </div>
            <div style={{ fontSize: 12.5, color: 'var(--fg-muted)', lineHeight: 1.55 }}>
              Resume Match needs a structured resume to compare against. Add one in
              the Resumes module first, then come back here.
            </div>
            <div>
              <Link to="/resumes" className="btn-primary" style={{ textDecoration: 'none', display: 'inline-flex' }}>
                <Icon name="arrowRight" size={12} /> Add a resume
              </Link>
            </div>
          </div>
        </div>
      </>
    )
  }

  return (
    <>
      <PageHeader
        title="Resume Match"
        subtitle={`Current resume: ${currentResume.name} · ${validJdCount} JD${validJdCount === 1 ? '' : 's'} ready`}
      />

      <div style={{ flex: 1, overflowY: 'auto', padding: '14px 28px 28px', display: 'flex', flexDirection: 'column', gap: 18 }}>
        {/* JD slots */}
        <section style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          <SectionLabel
            label="Job descriptions to compare"
            action={
              <button className="btn-secondary" onClick={() => setJds((j) => [...j, newSlot()])}>
                <Icon name="plus" size={12} /> Add JD
              </button>
            }
          />
          <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
            {jds.map((jd, i) => (
              <JdSlotCard
                key={jd.id}
                index={i}
                jd={jd}
                apps={apps}
                companies={companies}
                onChange={(patch) =>
                  setJds((arr) => arr.map((x) => (x.id === jd.id ? { ...x, ...patch } : x)))
                }
                onRemove={() => setJds((arr) => arr.filter((x) => x.id !== jd.id))}
                canRemove={jds.length > 1}
              />
            ))}
          </div>
        </section>

        {/* Prompt preview (collapsed) */}
        <section>
          <details>
            <summary style={{ fontSize: 11.5, color: 'var(--fg-muted)', cursor: 'pointer' }}>
              Show generated prompt ({prompt.length.toLocaleString()} chars)
            </summary>
            <textarea
              readOnly
              value={prompt}
              style={{
                width: '100%', minHeight: 160, marginTop: 8, padding: 10,
                fontSize: 11.5, fontFamily: 'var(--font-mono)', resize: 'vertical',
              }}
            />
          </details>
        </section>

        {/* Provider strip */}
        <section>
          <SectionLabel label="AIs" />
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 12 }}>
            {PROVIDER_LIST.map((p) => (
              <ProviderCard
                key={p}
                provider={p}
                state={providers[p]}
                canLaunch={canLaunch}
                parsedSummary={(s) => `${s.rankings.length} ranking${s.rankings.length === 1 ? '' : 's'}`}
                placeholder='{"rankings":[{"jd_id":"jd-xxx","rank":1,"score":8.5,"reasons":["..."],"gaps":["..."]}]}'
                onLaunch={() => onLaunch(p)}
                onManualPaste={() => onManualPaste(p)}
                onSubmit={(text) => onPaste(p, text)}
                onReset={() => resetProvider(p)}
              />
            ))}
          </div>
        </section>

        {/* Comparison */}
        {PROVIDER_LIST.some((p) => providers[p].status === 'parsed') && (
          <section>
            <SectionLabel label="Comparison" />
            <Comparison providers={providers} jds={jds} />
          </section>
        )}
      </div>
    </>
  )
}

// ──────────────────────────────────────────────────────────────────────────
// Small subcomponents
// ──────────────────────────────────────────────────────────────────────────

function SectionLabel({ label, action }: { label: string; action?: React.ReactNode }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
      <span
        style={{
          fontSize: 10.5, fontWeight: 600, color: 'var(--fg-muted)',
          textTransform: 'uppercase', letterSpacing: '0.06em',
        }}
      >
        {label}
      </span>
      <div style={{ flex: 1 }} />
      {action}
    </div>
  )
}

function JdSlotCard({
  index,
  jd,
  apps,
  companies,
  onChange,
  onRemove,
  canRemove,
}: {
  index: number
  jd: JdSlot
  apps: any[]
  companies: any[]
  onChange: (patch: Partial<JdSlot>) => void
  onRemove: () => void
  canRemove: boolean
}) {
  const insertFromApp = (appId: string) => {
    const app = apps.find((a) => a.id === appId)
    if (!app) return
    const co = companies.find((c) => c.id === app.companyId)
    onChange({
      title: [co?.name, app.role].filter(Boolean).join(' — '),
      body: jd.body || `Source: ${app.source ?? 'manual'}\nLocation: ${app.location ?? ''}\nStage: ${app.stage}\nNotes: ${app.notes ?? ''}`,
    })
  }
  return (
    <div
      style={{
        background: 'var(--surface)',
        border: '0.5px solid var(--border)',
        borderRadius: 8,
        padding: 12,
        display: 'flex', flexDirection: 'column', gap: 8,
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <span style={{
          width: 22, height: 22, borderRadius: 11, background: 'var(--surface-3)',
          color: 'var(--fg-muted)', display: 'flex', alignItems: 'center', justifyContent: 'center',
          fontSize: 11.5, fontWeight: 600, fontVariantNumeric: 'tabular-nums',
        }}>{index + 1}</span>
        <input
          type="text"
          value={jd.title}
          onChange={(e) => onChange({ title: e.target.value })}
          placeholder="Title (e.g. Helix Robotics — Senior Frontend Engineer)"
          style={{ flex: 1, padding: '5px 9px', fontSize: 12.5 }}
        />
        {apps.length > 0 && (
          <select
            value=""
            onChange={(e) => { if (e.target.value) insertFromApp(e.target.value) }}
            style={{ padding: '5px 8px', fontSize: 11.5, maxWidth: 200 }}
            title="Insert from a saved application"
          >
            <option value="">Insert from saved…</option>
            {apps.slice(0, 50).map((a) => {
              const co = companies.find((c) => c.id === a.companyId)
              return (
                <option key={a.id} value={a.id}>
                  {co?.name ? `${co.name} — ${a.role}` : a.role}
                </option>
              )
            })}
          </select>
        )}
        {canRemove && (
          <button
            onClick={onRemove}
            className="icon-btn"
            style={{ background: 'transparent', border: 'none', cursor: 'pointer', padding: 4, color: 'var(--fg-muted)' }}
            title="Remove"
          >
            <Icon name="x" size={13} />
          </button>
        )}
      </div>
      <textarea
        value={jd.body}
        onChange={(e) => onChange({ body: e.target.value })}
        placeholder="Paste the JD body here…"
        style={{ width: '100%', minHeight: 100, padding: 10, fontSize: 11.5, lineHeight: 1.5, resize: 'vertical' }}
      />
    </div>
  )
}

// Provider card with inline paste textarea. Same Launch / Paste / Parse
// rhythm as resumes-page.tsx and jd-breakdown-page.tsx. Each card owns its
// own draft state; parent only sees the final text on Submit.
function ProviderCard({
  provider, state, canLaunch, parsedSummary, placeholder,
  onLaunch, onManualPaste, onSubmit, onReset,
}: {
  provider: Provider
  state: ProviderState
  canLaunch: boolean
  parsedSummary: (s: Extract<ProviderState, { status: 'parsed' }>) => string
  placeholder?: string
  onLaunch: () => void
  onManualPaste: () => void
  onSubmit: (text: string) => void | Promise<void>
  onReset: () => void
}) {
  const cfg = PROVIDERS[provider as Exclude<Provider, 'other'>]
  if (!cfg) return null
  const [draft, setDraft] = useState('')

  // Clear textarea whenever the card transitions out of awaiting.
  React.useEffect(() => {
    if (state.status !== 'awaiting') setDraft('')
  }, [state.status])

  return (
    <div
      style={{
        background: 'var(--surface)',
        border: '0.5px solid var(--border)',
        borderRadius: 10,
        padding: 12,
        display: 'flex', flexDirection: 'column', gap: 10,
      }}
    >
      <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--fg)' }}>{cfg.label}</div>

      {state.status === 'idle' && (
        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
          <button className="btn-primary" disabled={!canLaunch} onClick={onLaunch}
            style={{ fontSize: 12, opacity: canLaunch ? 1 : 0.5 }}>
            <Icon name="external" size={12} /> Launch
          </button>
          <button
            className="btn-secondary"
            disabled={!canLaunch}
            onClick={onManualPaste}
            title="Already ran the prompt in another tab? Paste the reply here"
            style={{ fontSize: 12, opacity: canLaunch ? 1 : 0.5 }}
          >
            <Icon name="doc" size={12} /> Paste reply
          </button>
        </div>
      )}

      {state.status === 'awaiting' && (
        <>
          <textarea
            autoFocus
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            placeholder={placeholder}
            style={{
              width: '100%', minHeight: 140, padding: 8,
              fontSize: 11, fontFamily: 'var(--font-mono)', resize: 'vertical',
            }}
          />
          <div style={{ display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' }}>
            <button
              className="btn-primary"
              disabled={!draft.trim()}
              onClick={() => onSubmit(draft)}
              style={{ fontSize: 12, opacity: draft.trim() ? 1 : 0.5 }}
            >
              <Icon name="check" size={12} /> Parse &amp; save
            </button>
            <button className="btn-secondary" onClick={onReset} style={{ fontSize: 11 }}>Cancel</button>
            <span style={{ marginLeft: 'auto', fontSize: 10.5, color: 'var(--fg-muted)' }}>
              {draft.length.toLocaleString()} chars
            </span>
          </div>
        </>
      )}

      {state.status === 'parsed' && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
          <Icon name="check" size={12} />
          <span style={{ fontSize: 11.5, color: 'var(--fg)' }}>{parsedSummary(state)}</span>
          <span style={{ fontSize: 10.5, color: 'var(--fg-muted)' }}>· {state.format}</span>
          <button className="btn-secondary" onClick={onReset}
            style={{ fontSize: 11, marginLeft: 'auto', padding: '3px 8px' }}>Re-run</button>
        </div>
      )}

      {state.status === 'failed' && (
        <>
          <div style={{
            fontSize: 11.5, color: 'oklch(0.45 0.15 30)',
            padding: 8, background: 'oklch(0.97 0.03 30)',
            border: '0.5px solid oklch(0.88 0.06 30)', borderRadius: 6,
            lineHeight: 1.5,
          }}>
            {state.error}
          </div>
          <div style={{ display: 'flex', gap: 6 }}>
            <button className="btn-secondary" onClick={onReset} style={{ fontSize: 12 }}>
              <Icon name="refresh" size={12} /> Try again
            </button>
            <button className="btn-secondary" onClick={onManualPaste} style={{ fontSize: 12 }}>
              <Icon name="doc" size={12} /> Paste new reply
            </button>
          </div>
        </>
      )}
    </div>
  )
}

// ──────────────────────────────────────────────────────────────────────────
// Side-by-side comparison: per provider, ranked list of JD ids → scores.
// ──────────────────────────────────────────────────────────────────────────

function Comparison({
  providers,
  jds,
}: {
  providers: Record<Provider, ProviderState>
  jds: JdSlot[]
}) {
  const jdTitle = (id: string) => {
    const match = jds.find((j) => j.id === id)
    if (match) return match.title || id
    return id
  }
  const present = PROVIDER_LIST.filter((p) => providers[p].status === 'parsed')

  return (
    <div style={{ display: 'grid', gridTemplateColumns: `repeat(${present.length}, 1fr)`, gap: 12 }}>
      {present.map((p) => {
        const s = providers[p] as Extract<ProviderState, { status: 'parsed' }>
        const sorted = [...s.rankings].sort((a, b) => a.rank - b.rank)
        return (
          <div
            key={p}
            style={{
              background: 'var(--surface)',
              border: '0.5px solid var(--border)',
              borderRadius: 10,
              padding: 12,
              display: 'flex', flexDirection: 'column', gap: 8,
            }}
          >
            <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--fg)' }}>
              {PROVIDERS[p as Exclude<Provider, 'other'>].label}
            </div>
            {sorted.length === 0 && (
              <div style={{ fontSize: 12, color: 'var(--fg-muted)' }}>No rankings.</div>
            )}
            {sorted.map((r) => (
              <div
                key={`${p}-${r.jd_id}`}
                style={{
                  padding: 10, background: 'var(--surface-2)', borderRadius: 6,
                  border: '0.5px solid var(--border)',
                  display: 'flex', flexDirection: 'column', gap: 4,
                }}
              >
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', gap: 6 }}>
                  <div style={{ fontSize: 12, fontWeight: 600, color: 'var(--fg)' }}>
                    #{r.rank} · {jdTitle(r.jd_id)}
                  </div>
                  <div
                    style={{
                      fontSize: 13, fontWeight: 600, fontVariantNumeric: 'tabular-nums',
                      color: r.score >= 7 ? 'oklch(0.40 0.13 155)' : r.score >= 5 ? 'var(--fg)' : 'oklch(0.45 0.15 30)',
                    }}
                  >
                    {r.score.toFixed(1)}
                  </div>
                </div>
                {r.reasons.length > 0 && (
                  <ul style={{ fontSize: 11, color: 'var(--fg-muted)', paddingLeft: 16, margin: 0, lineHeight: 1.5 }}>
                    {r.reasons.slice(0, 4).map((reason, i) => <li key={i}>{reason}</li>)}
                  </ul>
                )}
                {r.gaps.length > 0 && (
                  <div style={{ fontSize: 11, color: 'oklch(0.45 0.15 30)', marginTop: 2 }}>
                    Gaps: {r.gaps.join(' · ')}
                  </div>
                )}
              </div>
            ))}
          </div>
        )
      })}
    </div>
  )
}
