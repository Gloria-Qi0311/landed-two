// JD Breakdown page (issue #22).
//
// Two AI round-trips against one shared JD:
//   A. Breakdown — extracts must-have / nice-to-have / gaps / match%
//   B. Tailor    — rewrites resume bullets to match the JD
//
// Both reuse the @landed/ai-roundtrip 3-provider strip pattern from
// resume-match-page.tsx (issue #21). Tailor is gated on a current resume
// existing; Breakdown works with just a JD (compares against the resume
// when present, otherwise pure requirements extraction).
//
// Replaces the prototype port at src/components/jd-breakdown.jsx, which
// hard-coded SOURCE_JD / PARSED / ORIGINAL_BULLETS / VARIANTS.
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
import type { Resume } from '@landed/schema'
import { PageHeader } from './shell'
import { Icon } from './primitives'
import { supabase } from '../lib/supabase'
import { useCurrentResume, useUpdateResume } from '../hooks/resumes'
import { useApplications, useCompanies } from '../hooks/queries'

// ── Schemas (inline; lift to @landed/schema if a third caller appears) ────

const GapSchema = z.object({
  skill: z.coerce.string(),
  weeks_to_close: z.coerce.number().int().nonnegative().default(0),
  why: z.coerce.string().default(''),
})
const BreakdownResponseSchema = z.object({
  must_have: z.array(z.coerce.string()).default([]),
  nice_to_have: z.array(z.coerce.string()).default([]),
  gaps: z.array(GapSchema).default([]),
  match_percent: z.coerce.number().min(0).max(100).default(0),
})
type Breakdown = z.infer<typeof BreakdownResponseSchema>

const TailoredBulletSchema = z.object({
  original: z.coerce.string(),
  tailored: z.coerce.string(),
  reason: z.coerce.string().default(''),
})
const TailorResponseSchema = z.object({
  tailored_bullets: z.array(TailoredBulletSchema),
})
type TailoredBullet = z.infer<typeof TailoredBulletSchema>

// ── Provider-state types (shared shape, parametrized by parsed payload) ───

type ProviderState<T> =
  | { status: 'idle' }
  | { status: 'awaiting'; prompt: string }
  | { status: 'parsed'; parsed: T; raw: string; format: ParseFormat; aiRunId?: string }
  | { status: 'failed'; raw: string; error: string }

type BreakdownState = ProviderState<Breakdown>
type TailorState = ProviderState<{ bullets: TailoredBullet[]; accepted: Set<number> }>

const PROVIDER_LIST: Provider[] = ['chatgpt', 'claude', 'gemini']
const initialStates = <T,>(): Record<Provider, ProviderState<T>> => ({
  chatgpt: { status: 'idle' },
  claude: { status: 'idle' },
  gemini: { status: 'idle' },
  other: { status: 'idle' },
})

// ── Word-level diff (LCS) for the tailor viewer ───────────────────────────

type DiffToken = { type: 'keep' | 'add' | 'remove'; text: string }

function wordDiff(orig: string, tail: string): DiffToken[] {
  if (orig === tail) return [{ type: 'keep', text: orig }]
  const a = orig.split(/(\s+)/)
  const b = tail.split(/(\s+)/)
  const m = a.length, n = b.length
  const dp: number[][] = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(0))
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      dp[i][j] = a[i - 1] === b[j - 1] ? dp[i - 1][j - 1] + 1 : Math.max(dp[i - 1][j], dp[i][j - 1])
    }
  }
  const out: DiffToken[] = []
  let i = m, j = n
  while (i > 0 || j > 0) {
    if (i > 0 && j > 0 && a[i - 1] === b[j - 1]) { out.push({ type: 'keep', text: a[i - 1] }); i--; j-- }
    else if (j > 0 && (i === 0 || dp[i][j - 1] >= dp[i - 1][j])) { out.push({ type: 'add', text: b[j - 1] }); j-- }
    else { out.push({ type: 'remove', text: a[i - 1] }); i-- }
  }
  out.reverse()
  const merged: DiffToken[] = []
  for (const tok of out) {
    if (merged.length && merged[merged.length - 1].type === tok.type) {
      merged[merged.length - 1].text += tok.text
    } else merged.push({ ...tok })
  }
  return merged
}

// ── Apply accepted bullets to a Resume via substring find/replace ─────────
//
// LLM emits { original, tailored } where `original` is supposed to match the
// resume verbatim. We scan each description field across experience /
// internship / projects for the first substring hit and replace it. If no
// substring matches we count it as "missed" — the user is shown the count
// and can copy/paste manually.

function applyTailoringToResume(
  resume: Resume,
  accepted: TailoredBullet[],
): { resume: Resume; appliedCount: number; missedBullets: string[] } {
  // Shallow-clone the arrays we touch so React Query treats the result as new
  const next: Resume = {
    ...resume,
    experience: resume.experience.map((e) => ({ ...e })),
    internship: resume.internship.map((e) => ({ ...e })),
    projects: resume.projects.map((p) => ({ ...p })),
  }
  let applied = 0
  const missed: string[] = []

  const sections: Array<{ rows: Array<{ description: string }> }> = [
    { rows: next.experience },
    { rows: next.internship },
    { rows: next.projects },
  ]

  for (const b of accepted) {
    const orig = b.original.trim()
    if (!orig) continue
    let found = false
    for (const section of sections) {
      for (const row of section.rows) {
        if (row.description && row.description.includes(orig)) {
          row.description = row.description.replace(orig, b.tailored)
          applied++
          found = true
          break
        }
      }
      if (found) break
    }
    if (!found) missed.push(orig.slice(0, 60))
  }
  return { resume: next, appliedCount: applied, missedBullets: missed }
}

// ── Main page ─────────────────────────────────────────────────────────────

export function JDBreakdownPage() {
  const { data: currentResume, isLoading: resumeLoading } = useCurrentResume()
  const { data: apps = [] } = useApplications()
  const { data: companies = [] } = useCompanies()
  const updateResume = useUpdateResume()

  const [jdTitle, setJdTitle] = useState('')
  const [jdBody, setJdBody] = useState('')

  const [breakdown, setBreakdown] = useState<Record<Provider, BreakdownState>>(initialStates<Breakdown>())
  const [tailor, setTailor] = useState<Record<Provider, TailorState>>(
    initialStates<{ bullets: TailoredBullet[]; accepted: Set<number> }>(),
  )
  const [applyNotice, setApplyNotice] = useState<string>('')

  const jdReady = jdBody.trim().length > 0

  const breakdownPrompt = useMemo(() => {
    if (!jdReady) return ''
    return generatePrompt('jd_breakdown', {
      jd: { title: jdTitle, body: jdBody },
      ...(currentResume?.parsed_json ? { resume: currentResume.parsed_json } : {}),
    })
  }, [jdReady, jdTitle, jdBody, currentResume])

  const tailorPrompt = useMemo(() => {
    if (!jdReady || !currentResume?.parsed_json) return ''
    return generatePrompt('resume_tailor', {
      resume: currentResume.parsed_json,
      jd: { title: jdTitle, body: jdBody },
    })
  }, [jdReady, jdTitle, jdBody, currentResume])

  // ── Launchers ────────────────────────────────────────────────────────────

  const onLaunchBreakdown = async (provider: Provider) => {
    if (!jdReady) return
    const r = await launchAI(provider, breakdownPrompt)
    if (!r.ok) {
      setBreakdown((p) => ({ ...p, [provider]: { status: 'failed', raw: '', error: r.reason } }))
      return
    }
    setBreakdown((p) => ({ ...p, [provider]: { status: 'awaiting', prompt: breakdownPrompt } }))
  }

  const onLaunchTailor = async (provider: Provider) => {
    if (!jdReady || !currentResume?.parsed_json) return
    const r = await launchAI(provider, tailorPrompt)
    if (!r.ok) {
      setTailor((p) => ({ ...p, [provider]: { status: 'failed', raw: '', error: r.reason } }))
      return
    }
    setTailor((p) => ({ ...p, [provider]: { status: 'awaiting', prompt: tailorPrompt } }))
  }

  // Manual-paste path: user already ran the prompt elsewhere; transition the
  // card straight to 'awaiting' without re-copying / re-opening the popup.
  const onManualPasteBreakdown = (provider: Provider) => {
    if (!jdReady) return
    setBreakdown((p) =>
      p[provider].status === 'idle' || p[provider].status === 'failed'
        ? { ...p, [provider]: { status: 'awaiting', prompt: breakdownPrompt } }
        : p,
    )
  }
  const onManualPasteTailor = (provider: Provider) => {
    if (!jdReady || !currentResume?.parsed_json) return
    setTailor((p) =>
      p[provider].status === 'idle' || p[provider].status === 'failed'
        ? { ...p, [provider]: { status: 'awaiting', prompt: tailorPrompt } }
        : p,
    )
  }

  // ── Paste handlers (parse + save once on explicit click) ─────────────────

  const onPasteBreakdown = async (provider: Provider, text: string) => {
    const parsed = tryParseResponse(text, BreakdownResponseSchema)
    if (!parsed.ok) {
      setBreakdown((p) => ({ ...p, [provider]: { status: 'failed', raw: text, error: parsed.error } }))
      saveAiRun(supabase, {
        task: 'jd_breakdown', provider, prompt: breakdownPrompt, response: text, parseFormat: 'failed',
      }).catch(() => {})
      return
    }
    const data = parsed.parsed as Breakdown
    setBreakdown((p) => ({
      ...p,
      [provider]: { status: 'parsed', parsed: data, raw: text, format: parsed.format },
    }))
    const save = await saveAiRun(supabase, {
      task: 'jd_breakdown', provider, prompt: breakdownPrompt, response: text,
      parsed: data, parseFormat: parsed.format,
    })
    if (save.ok) {
      setBreakdown((p) =>
        p[provider].status === 'parsed'
          ? { ...p, [provider]: { ...(p[provider] as Extract<BreakdownState, { status: 'parsed' }>), aiRunId: save.id } }
          : p,
      )
    }
  }

  const onPasteTailor = async (provider: Provider, text: string) => {
    const parsed = tryParseResponse(text, TailorResponseSchema)
    if (!parsed.ok) {
      setTailor((p) => ({ ...p, [provider]: { status: 'failed', raw: text, error: parsed.error } }))
      saveAiRun(supabase, {
        task: 'resume_tailor', provider, prompt: tailorPrompt, response: text, parseFormat: 'failed',
      }).catch(() => {})
      return
    }
    const data = parsed.parsed as { tailored_bullets: TailoredBullet[] }
    // Defensive filter: tryParseResponse returns the raw parsed object even
    // when zod validation fails (tier-1 "valid JSON but schema mismatch").
    // Drop any bullet missing the required string fields so BulletDiff /
    // applyTailoringToResume can't blow up on `undefined.trim()`.
    const bullets: TailoredBullet[] = (Array.isArray(data?.tailored_bullets) ? data.tailored_bullets : [])
      .filter((b: any) => typeof b?.original === 'string' && typeof b?.tailored === 'string')
      .map((b: any) => ({ original: b.original, tailored: b.tailored, reason: typeof b.reason === 'string' ? b.reason : '' }))
    // Default to all-accepted so users can one-click "Apply" out of the gate
    const accepted = new Set<number>(bullets.map((_, i) => i))
    setTailor((p) => ({
      ...p,
      [provider]: { status: 'parsed', parsed: { bullets, accepted }, raw: text, format: parsed.format },
    }))
    const save = await saveAiRun(supabase, {
      task: 'resume_tailor', provider, prompt: tailorPrompt, response: text,
      parsed: data, parseFormat: parsed.format,
    })
    if (save.ok) {
      setTailor((p) =>
        p[provider].status === 'parsed'
          ? { ...p, [provider]: { ...(p[provider] as Extract<TailorState, { status: 'parsed' }>), aiRunId: save.id } }
          : p,
      )
    }
  }

  const resetBreakdown = (provider: Provider) => {
    setBreakdown((p) => ({ ...p, [provider]: { status: 'idle' } }))
  }
  const resetTailor = (provider: Provider) => {
    setTailor((p) => ({ ...p, [provider]: { status: 'idle' } }))
  }

  // ── Tailor: toggle accept / accept-all / reject-all / apply ──────────────

  const toggleBullet = (provider: Provider, index: number) => {
    setTailor((p) => {
      const s = p[provider]
      if (s.status !== 'parsed') return p
      const accepted = new Set(s.parsed.accepted)
      if (accepted.has(index)) accepted.delete(index)
      else accepted.add(index)
      return { ...p, [provider]: { ...s, parsed: { ...s.parsed, accepted } } }
    })
  }

  const setAllBullets = (provider: Provider, accept: boolean) => {
    setTailor((p) => {
      const s = p[provider]
      if (s.status !== 'parsed') return p
      const accepted = accept ? new Set<number>(s.parsed.bullets.map((_, i) => i)) : new Set<number>()
      return { ...p, [provider]: { ...s, parsed: { ...s.parsed, accepted } } }
    })
  }

  const onApply = async (provider: Provider) => {
    if (!currentResume?.parsed_json) return
    const s = tailor[provider]
    if (s.status !== 'parsed') return
    const acceptedBullets = s.parsed.bullets.filter((_, i) => s.parsed.accepted.has(i))
    if (acceptedBullets.length === 0) return
    const result = applyTailoringToResume(currentResume.parsed_json, acceptedBullets)
    try {
      await updateResume.mutateAsync({
        id: currentResume.id,
        patch: { parsed_json: result.resume },
      })
      const missedNote = result.missedBullets.length
        ? ` (${result.missedBullets.length} bullet${result.missedBullets.length === 1 ? '' : 's'} not found in resume — copy/paste manually)`
        : ''
      setApplyNotice(`Applied ${result.appliedCount}/${acceptedBullets.length} tailored bullet${result.appliedCount === 1 ? '' : 's'} to "${currentResume.name}"${missedNote}.`)
    } catch (e) {
      setApplyNotice(`Failed to apply: ${e instanceof Error ? e.message : String(e)}`)
    }
  }

  // ── Render ───────────────────────────────────────────────────────────────

  if (resumeLoading) {
    return <PageHeader title="JD Breakdown" subtitle="Loading…" />
  }

  return (
    <>
      <PageHeader
        title="JD Breakdown"
        subtitle={
          currentResume
            ? `Current resume: ${currentResume.name} · paste a JD to extract requirements + tailor bullets`
            : 'Paste a JD to extract requirements. Add a resume for tailoring + gap analysis.'
        }
      />

      <div style={{ flex: 1, overflowY: 'auto', padding: '14px 28px 28px', display: 'flex', flexDirection: 'column', gap: 18 }}>
        {/* Source JD */}
        <section style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          <SectionLabel
            label="Source JD"
            action={
              <SavedAppPicker
                apps={apps}
                companies={companies}
                onPick={(title, body) => {
                  setJdTitle(title)
                  setJdBody((b) => b || body)
                }}
              />
            }
          />
          <input
            value={jdTitle}
            onChange={(e) => setJdTitle(e.target.value)}
            placeholder="Role title — e.g. Staff Frontend Engineer, Acme Co"
            style={{
              width: '100%', padding: 10, fontSize: 13,
              background: 'var(--surface)', border: '0.5px solid var(--border)', borderRadius: 8,
            }}
          />
          <textarea
            value={jdBody}
            onChange={(e) => setJdBody(e.target.value)}
            placeholder="Paste the full JD body here…"
            style={{
              width: '100%', minHeight: 180, padding: 10, fontSize: 11.5, lineHeight: 1.55,
              fontFamily: 'var(--font-mono)', resize: 'vertical',
              background: 'var(--surface)', border: '0.5px solid var(--border)', borderRadius: 8,
            }}
          />
          <div style={{ fontSize: 11, color: 'var(--fg-muted)' }}>
            {jdBody.length.toLocaleString()} chars · {jdBody.trim().split(/\s+/).filter(Boolean).length.toLocaleString()} words
            {jdBody.length > 16_000 && <span style={{ color: 'oklch(0.45 0.15 30)' }}> · will truncate at 16k for prompt</span>}
          </div>
        </section>

        {/* Breakdown — provider strip + results */}
        <section style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          <SectionLabel label="Breakdown — requirements + gap analysis" />
          <PromptPreview prompt={breakdownPrompt} disabled={!jdReady} />
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 12 }}>
            {PROVIDER_LIST.map((p) => (
              <ProviderCard
                key={p}
                provider={p}
                state={breakdown[p]}
                canLaunch={jdReady}
                parsedSummary={(s) =>
                  `${s.parsed.must_have.length} must · ${s.parsed.nice_to_have.length} nice · ${s.parsed.gaps.length} gaps`
                }
                placeholder='{"must_have":[...],"nice_to_have":[...],"gaps":[{"skill":"...","weeks_to_close":2,"why":"..."}],"match_percent":72}'
                onLaunch={() => onLaunchBreakdown(p)}
                onManualPaste={() => onManualPasteBreakdown(p)}
                onSubmit={(text) => onPasteBreakdown(p, text)}
                onReset={() => resetBreakdown(p)}
              />
            ))}
          </div>
          {PROVIDER_LIST.some((p) => breakdown[p].status === 'parsed') && (
            <BreakdownResults breakdown={breakdown} />
          )}
        </section>

        {/* Tailor — gated on current resume */}
        <section style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          <SectionLabel
            label="Resume Tailor — rewrite bullets for this JD"
            action={
              applyNotice && (
                <span style={{ fontSize: 11, color: applyNotice.startsWith('Failed') ? 'oklch(0.45 0.15 30)' : 'var(--fg-muted)' }}>
                  {applyNotice}
                </span>
              )
            }
          />
          {!currentResume?.parsed_json ? (
            <EmptyResumeHint />
          ) : (
            <>
              <PromptPreview prompt={tailorPrompt} disabled={!jdReady} />
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 12 }}>
                {PROVIDER_LIST.map((p) => (
                  <ProviderCard
                    key={p}
                    provider={p}
                    state={tailor[p]}
                    canLaunch={jdReady && !!currentResume?.parsed_json}
                    parsedSummary={(s) =>
                      `${s.parsed.accepted.size}/${s.parsed.bullets.length} accepted`
                    }
                    placeholder='{"tailored_bullets":[{"original":"...","tailored":"...","reason":"..."}]}'
                    onLaunch={() => onLaunchTailor(p)}
                    onManualPaste={() => onManualPasteTailor(p)}
                    onSubmit={(text) => onPasteTailor(p, text)}
                    onReset={() => resetTailor(p)}
                  />
                ))}
              </div>
              {PROVIDER_LIST.some((p) => tailor[p].status === 'parsed') && (
                <TailorResults
                  tailor={tailor}
                  isApplying={updateResume.isPending}
                  onToggle={toggleBullet}
                  onAcceptAll={(p) => setAllBullets(p, true)}
                  onRejectAll={(p) => setAllBullets(p, false)}
                  onApply={onApply}
                />
              )}
            </>
          )}
        </section>

      </div>
    </>
  )
}

// ── Small subcomponents ───────────────────────────────────────────────────

function SectionLabel({ label, action }: { label: string; action?: React.ReactNode }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 4 }}>
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

function PromptPreview({ prompt, disabled }: { prompt: string; disabled: boolean }) {
  if (disabled) return null
  return (
    <details>
      <summary style={{ fontSize: 11.5, color: 'var(--fg-muted)', cursor: 'pointer' }}>
        Show generated prompt ({prompt.length.toLocaleString()} chars)
      </summary>
      <textarea
        readOnly
        value={prompt}
        style={{
          width: '100%', minHeight: 140, marginTop: 8, padding: 10,
          fontSize: 11.5, fontFamily: 'var(--font-mono)', resize: 'vertical',
        }}
      />
    </details>
  )
}

function SavedAppPicker({
  apps, companies, onPick,
}: {
  apps: any[]; companies: any[]; onPick: (title: string, body: string) => void
}) {
  if (!apps.length) return null
  return (
    <select
      defaultValue=""
      onChange={(e) => {
        const app = apps.find((a) => a.id === e.target.value)
        if (!app) return
        const co = companies.find((c) => c.id === app.companyId)
        const title = [co?.name, app.role].filter(Boolean).join(' — ')
        const body = `Source: ${app.source ?? 'manual'}\nLocation: ${app.location ?? ''}\nStage: ${app.stage}\nNotes: ${app.notes ?? ''}`
        onPick(title, body)
        e.target.value = ''
      }}
      style={{ fontSize: 11.5, padding: '4px 6px' }}
    >
      <option value="" disabled>Insert from saved app…</option>
      {apps.map((a) => {
        const co = companies.find((c) => c.id === a.companyId)
        return (
          <option key={a.id} value={a.id}>
            {[co?.name, a.role].filter(Boolean).join(' — ')}
          </option>
        )
      })}
    </select>
  )
}

// Provider card with inline paste textarea — same Launch / Paste / Parse
// rhythm as the Resume upload flow (resumes-page.tsx). Each card owns its
// own draft state; parent only sees the final text on Submit.
function ProviderCard<T>({
  provider, state, canLaunch, parsedSummary, placeholder,
  onLaunch, onManualPaste, onSubmit, onReset,
}: {
  provider: Provider
  state: ProviderState<T>
  canLaunch: boolean
  parsedSummary: (s: Extract<ProviderState<T>, { status: 'parsed' }>) => string
  placeholder?: string
  onLaunch: () => void
  onManualPaste: () => void
  onSubmit: (text: string) => void | Promise<void>
  onReset: () => void
}) {
  const cfg = PROVIDERS[provider as Exclude<Provider, 'other'>]
  if (!cfg) return null
  const [draft, setDraft] = useState('')

  // Clear the textarea any time the card transitions out of awaiting.
  React.useEffect(() => {
    if (state.status !== 'awaiting') setDraft('')
  }, [state.status])

  return (
    <div
      style={{
        background: 'var(--surface)', border: '0.5px solid var(--border)', borderRadius: 10,
        padding: 12, display: 'flex', flexDirection: 'column', gap: 10,
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

function EmptyResumeHint() {
  return (
    <div
      style={{
        padding: 12, background: 'var(--surface-2)',
        border: '0.5px dashed var(--border)', borderRadius: 8,
        fontSize: 12, color: 'var(--fg-muted)', lineHeight: 1.55,
      }}
    >
      Add a current resume in the Resumes module to enable bullet tailoring.
      The Breakdown above still works without one.
    </div>
  )
}

// ── Breakdown results ─────────────────────────────────────────────────────

function BreakdownResults({ breakdown }: { breakdown: Record<Provider, BreakdownState> }) {
  const present = PROVIDER_LIST.filter((p) => breakdown[p].status === 'parsed')
  if (present.length === 0) return null
  return (
    <div style={{ display: 'grid', gridTemplateColumns: `repeat(${present.length}, 1fr)`, gap: 12 }}>
      {present.map((p) => {
        const s = breakdown[p] as Extract<BreakdownState, { status: 'parsed' }>
        const pct = Math.round(s.parsed.match_percent)
        const pctColor = pct >= 70 ? 'oklch(0.40 0.13 155)' : pct >= 40 ? 'var(--fg)' : 'oklch(0.45 0.15 30)'
        return (
          <div
            key={p}
            style={{
              background: 'var(--surface)', border: '0.5px solid var(--border)', borderRadius: 10,
              padding: 12, display: 'flex', flexDirection: 'column', gap: 10,
            }}
          >
            <div style={{ display: 'flex', alignItems: 'baseline', gap: 8 }}>
              <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--fg)' }}>
                {PROVIDERS[p as Exclude<Provider, 'other'>].label}
              </div>
              <div style={{ marginLeft: 'auto', fontSize: 18, fontWeight: 600, color: pctColor, fontVariantNumeric: 'tabular-nums' }}>
                {pct}%
              </div>
              <div style={{ fontSize: 10, color: 'var(--fg-muted)' }}>match</div>
            </div>

            {s.parsed.must_have.length > 0 && (
              <div>
                <div style={{ fontSize: 10.5, fontWeight: 600, color: 'var(--fg-muted)', textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: 4 }}>
                  Must-have ({s.parsed.must_have.length})
                </div>
                <ul style={{ paddingLeft: 16, margin: 0, fontSize: 12, lineHeight: 1.55 }}>
                  {s.parsed.must_have.map((it, i) => <li key={i}>{it}</li>)}
                </ul>
              </div>
            )}
            {s.parsed.nice_to_have.length > 0 && (
              <div>
                <div style={{ fontSize: 10.5, fontWeight: 600, color: 'var(--fg-muted)', textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: 4 }}>
                  Nice-to-have ({s.parsed.nice_to_have.length})
                </div>
                <ul style={{ paddingLeft: 16, margin: 0, fontSize: 11.5, lineHeight: 1.55, color: 'var(--fg-muted)' }}>
                  {s.parsed.nice_to_have.map((it, i) => <li key={i}>{it}</li>)}
                </ul>
              </div>
            )}
            {s.parsed.gaps.length > 0 && (
              <div>
                <div style={{ fontSize: 10.5, fontWeight: 600, color: 'oklch(0.45 0.15 30)', textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: 4 }}>
                  Gaps ({s.parsed.gaps.length})
                </div>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                  {s.parsed.gaps.map((g, i) => (
                    <div key={i} style={{ padding: 8, background: 'var(--surface-2)', borderRadius: 6, fontSize: 11.5 }}>
                      <div style={{ display: 'flex', alignItems: 'baseline', gap: 6 }}>
                        <span style={{ fontWeight: 600, color: 'var(--fg)' }}>{g.skill}</span>
                        {g.weeks_to_close > 0 && (
                          <span style={{ color: 'var(--fg-muted)', fontSize: 10.5 }}>
                            ~{g.weeks_to_close} week{g.weeks_to_close === 1 ? '' : 's'} to close
                          </span>
                        )}
                      </div>
                      {g.why && <div style={{ color: 'var(--fg-muted)', marginTop: 2, lineHeight: 1.5 }}>{g.why}</div>}
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>
        )
      })}
    </div>
  )
}

// ── Tailor results ────────────────────────────────────────────────────────

function TailorResults({
  tailor, isApplying, onToggle, onAcceptAll, onRejectAll, onApply,
}: {
  tailor: Record<Provider, TailorState>
  isApplying: boolean
  onToggle: (p: Provider, i: number) => void
  onAcceptAll: (p: Provider) => void
  onRejectAll: (p: Provider) => void
  onApply: (p: Provider) => void
}) {
  const present = PROVIDER_LIST.filter((p) => tailor[p].status === 'parsed')
  if (present.length === 0) return null
  return (
    <div style={{ display: 'grid', gridTemplateColumns: `repeat(${present.length}, 1fr)`, gap: 12 }}>
      {present.map((p) => {
        const s = tailor[p] as Extract<TailorState, { status: 'parsed' }>
        const { bullets, accepted } = s.parsed
        return (
          <div
            key={p}
            style={{
              background: 'var(--surface)', border: '0.5px solid var(--border)', borderRadius: 10,
              padding: 12, display: 'flex', flexDirection: 'column', gap: 10,
            }}
          >
            <div style={{ display: 'flex', alignItems: 'baseline', gap: 8 }}>
              <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--fg)' }}>
                {PROVIDERS[p as Exclude<Provider, 'other'>].label}
              </div>
              <div style={{ marginLeft: 'auto', fontSize: 11, color: 'var(--fg-muted)' }}>
                {accepted.size}/{bullets.length} accepted
              </div>
            </div>

            <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              {bullets.length === 0 && (
                <div style={{ fontSize: 12, color: 'var(--fg-muted)' }}>No bullets returned.</div>
              )}
              {bullets.map((b, i) => (
                <BulletDiff
                  key={i}
                  bullet={b}
                  accepted={accepted.has(i)}
                  onToggle={() => onToggle(p, i)}
                />
              ))}
            </div>

            <div style={{ display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' }}>
              <button className="btn-secondary" onClick={() => onAcceptAll(p)} style={{ fontSize: 11 }}>
                Accept all
              </button>
              <button className="btn-secondary" onClick={() => onRejectAll(p)} style={{ fontSize: 11 }}>
                Reject all
              </button>
              <button
                className="btn-primary"
                disabled={accepted.size === 0 || isApplying}
                onClick={() => onApply(p)}
                style={{ fontSize: 11, marginLeft: 'auto', opacity: accepted.size === 0 || isApplying ? 0.5 : 1 }}
              >
                <Icon name="check" size={12} /> {isApplying ? 'Applying…' : `Apply ${accepted.size} to resume`}
              </button>
            </div>
          </div>
        )
      })}
    </div>
  )
}

function BulletDiff({
  bullet, accepted, onToggle,
}: { bullet: TailoredBullet; accepted: boolean; onToggle: () => void }) {
  const tokens = useMemo(() => wordDiff(bullet.original, bullet.tailored), [bullet.original, bullet.tailored])
  return (
    <div
      style={{
        padding: 10, background: accepted ? 'var(--surface)' : 'var(--surface-2)',
        border: accepted ? '0.5px solid oklch(0.85 0.08 155)' : '0.5px solid var(--border)',
        borderRadius: 8, opacity: accepted ? 1 : 0.85,
        display: 'flex', flexDirection: 'column', gap: 6,
      }}
    >
      <div style={{ fontSize: 11, color: 'var(--fg-muted)', fontStyle: 'italic', lineHeight: 1.5, textDecoration: 'line-through' }}>
        {bullet.original}
      </div>
      <div style={{ fontSize: 12, color: 'var(--fg)', lineHeight: 1.55 }}>
        {tokens.filter((t) => t.type !== 'remove').map((t, i) =>
          t.type === 'add'
            ? <span key={i} style={{ background: 'oklch(0.93 0.10 155)', color: 'oklch(0.30 0.13 155)', padding: '0 2px', borderRadius: 2 }}>{t.text}</span>
            : <span key={i}>{t.text}</span>
        )}
      </div>
      {bullet.reason && (
        <div style={{ fontSize: 10.5, color: 'var(--fg-muted)', fontStyle: 'italic', lineHeight: 1.5 }}>
          Why: {bullet.reason}
        </div>
      )}
      <div>
        <button
          className="btn-secondary"
          onClick={onToggle}
          style={{
            fontSize: 11, padding: '3px 8px',
            color: accepted ? 'oklch(0.40 0.13 155)' : 'var(--fg-muted)',
          }}
        >
          <Icon name={accepted ? 'check' : 'plus'} size={11} /> {accepted ? 'Accepted' : 'Accept'}
        </button>
      </div>
    </div>
  )
}

