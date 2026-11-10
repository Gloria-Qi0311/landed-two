// Questions forms asked that nothing answered yet (Extension page; the
// sidebar's Extension item counts them, "Needs your input" points here). The
// extension reports the fields a fill had to leave empty, the page bridge
// keeps them with the application answers (hooks/extension-bridge.ts), and
// the user answers each once: the answer goes to the field the question is
// about, else "other questions", and the next fill answers it on any site
// that asks it (packages/schema/src/application-answers.ts → answerPending).
import { useState } from 'react'
import { Link } from 'react-router-dom'
import { answerPending, skipPending, type PendingQuestion } from '@landed/schema/application-answers'
import { Icon } from './primitives'
import { useApplicationAnswers, useSaveApplicationAnswers } from '../hooks/answers'
import { muted, card, danger } from './ui'

const YES_NO_KEYS = new Set([
  'adult', 'onsite', 'work_authorized', 'needs_sponsorship', 'relocate', 'travel', 'open_to_other_locations', 'previously_employed',
  'non_compete', 'talent_network',
])

const KEY_LABELS: Record<string, string> = {
  legal_first_name: 'Legal first name', legal_middle_name: 'Legal middle name', legal_last_name: 'Legal last name',
  preferred_first_name: 'Preferred first name', preferred_last_name: 'Preferred last name', address_line1: 'Address line 1',
  address_line2: 'Address line 2', city: 'City', state: 'State', postal_code: 'Postal code', country: 'Country',
  earliest_start: 'Earliest start', heard_from: 'How you heard about the job', linkedin: 'LinkedIn', github: 'GitHub', website: 'Website',
  adult: '18 or older', onsite: 'Onsite', work_authorized: 'Authorized to work', needs_sponsorship: 'Needs sponsorship', relocate: 'Relocate',
  travel: 'Travel', open_to_other_locations: 'Other locations', previously_employed: 'Worked here before', non_compete: 'Non-compete',
  talent_network: 'Talent network',
}

/** The pending questions, for counts elsewhere. */
export function usePendingQuestions(): PendingQuestion[] {
  return useApplicationAnswers().data?.answers.unanswered ?? []
}

export function PendingQuestionsCard() {
  const stored = useApplicationAnswers()
  const save = useSaveApplicationAnswers()
  const pending = stored.data?.answers.unanswered ?? []
  if (pending.length === 0) return null
  const answers = stored.data!.answers
  return (
    <div style={card}>
      <div>
        <div style={{ fontSize: 15, fontWeight: 600, color: 'var(--fg)' }}>
          Questions forms asked <span style={{ ...muted, fontWeight: 400 }}>· {pending.length}</span>
        </div>
        <div style={muted}>
          The extension had to leave these empty on forms you filled. Answer each once: it fills them from now on, on any site that asks the same
          question, and on pages you still have open.
        </div>
      </div>
      {save.error && <div role="alert" style={{ ...muted, color: danger }}>{(save.error as Error).message}</div>}
      <div style={{ display: 'flex', flexDirection: 'column' }}>
        {pending.map((q, i) => (
          <PendingRow key={q.question} q={q} first={i === 0} busy={save.isPending}
            onAnswer={(value) => save.mutate(answerPending(answers, q.question, value))}
            onSkip={() => save.mutate(skipPending(answers, q.question))} />
        ))}
      </div>
    </div>
  )
}

function PendingRow({ q, first, busy, onAnswer, onSkip }: {
  q: PendingQuestion; first: boolean; busy: boolean; onAnswer: (value: string) => void; onSkip: () => void
}) {
  const [value, setValue] = useState('')
  const yesNo = q.key !== null && YES_NO_KEYS.has(q.key)
  const sites = q.sites.length ? `Asked on ${q.sites.join(', ')}` : 'Asked on a form'
  const where = q.key ? ` · saved as “${KEY_LABELS[q.key] ?? q.key}”` : ''
  const submit = (v: string) => { if (v.trim()) onAnswer(v) }
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 6, padding: '10px 0', borderTop: first ? 'none' : '1px solid var(--border-subtle)' }}>
      <div style={{ fontSize: 13, fontWeight: 500, color: 'var(--fg)' }}>{q.question}</div>
      <div style={muted}>{sites}{q.seen > 1 ? ` · ${q.seen} times` : ''}{where}</div>
      <form style={{ display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' }} onSubmit={(e) => { e.preventDefault(); submit(value) }}>
        {yesNo ? (
          <>
            <button type="button" className="btn-secondary" disabled={busy} onClick={() => onAnswer('yes')}>Yes</button>
            <button type="button" className="btn-secondary" disabled={busy} onClick={() => onAnswer('no')}>No</button>
          </>
        ) : q.options.length ? (
          <>
            <select aria-label={`Answer: ${q.question}`} value={value} onChange={(e) => setValue(e.target.value)} style={{ fontSize: 12.5, maxWidth: 320 }}>
              <option value="">Choose…</option>
              {q.options.map((o) => <option key={o} value={o}>{o}</option>)}
            </select>
            <button type="submit" className="btn-primary" disabled={busy || !value} style={{ opacity: busy || !value ? 0.45 : 1 }}><Icon name="check" size={12} /> Save</button>
          </>
        ) : (
          <>
            <input type="text" aria-label={`Answer: ${q.question}`} value={value} onChange={(e) => setValue(e.target.value)}
              placeholder="Your answer" style={{ flex: '1 1 220px', maxWidth: 360, fontSize: 12.5 }} />
            <button type="submit" className="btn-primary" disabled={busy || !value.trim()} style={{ opacity: busy || !value.trim() ? 0.45 : 1 }}><Icon name="check" size={12} /> Save</button>
          </>
        )}
        <button type="button" className="btn-ghost" disabled={busy} onClick={onSkip} style={{ fontSize: 12 }}>Don't ask again</button>
      </form>
    </div>
  )
}

/** Under "Needs your input": a pointer to the Extension page while questions wait. */
export function PendingQuestionsNotice({ style }: { style?: React.CSSProperties }) {
  const pending = usePendingQuestions()
  if (pending.length === 0) return null
  return (
    <div style={style}>
      <div style={{ fontSize: 12.5, lineHeight: 1.45 }}>
        Application forms asked <b>{pending.length} question{pending.length === 1 ? '' : 's'}</b> you haven't answered yet, like “{pending[0].question}”.
      </div>
      <div>
        <Link to="/extension" className="btn-secondary" style={{ textDecoration: 'none', display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 12 }}>
          Answer {pending.length === 1 ? 'it' : 'them'} on the Extension page
        </Link>
      </div>
    </div>
  )
}
