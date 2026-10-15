// Answers the agent read from a form the user already filled
// (```landed-answers, packages/schema/src/application-answers.ts), shown in
// the chat as a card. Saving merges them into the Extension page's
// application answers: what it read replaces, the rest stays, and the
// consent switch is left alone. The agent never saves anything itself.
import { useState, type CSSProperties } from 'react'
import { Link } from 'react-router-dom'
import { EMPTY_ANSWERS, mergeAnswers, type ApplicationAnswers } from '@landed/schema/application-answers'
import { Icon } from './primitives'
import { useApplicationAnswers, useSaveApplicationAnswers } from '../hooks/answers'

const muted: CSSProperties = { fontSize: 11.5, color: 'var(--fg-muted)', lineHeight: 1.5 }

const LABELS: Partial<Record<keyof ApplicationAnswers, string>> = {
  legal_first_name: 'Legal first name', legal_middle_name: 'Legal middle name', legal_last_name: 'Legal last name',
  preferred_first_name: 'Preferred first name', preferred_last_name: 'Preferred last name', date_of_birth: 'Date of birth',
  linkedin: 'LinkedIn', github: 'GitHub', website: 'Website', adult: '18 or older', onsite: 'Onsite',
  address_line1: 'Address', address_line2: 'Address line 2', city: 'City', state: 'State', postal_code: 'ZIP', country: 'Country',
  work_authorized: 'Authorized to work', needs_sponsorship: 'Needs sponsorship', earliest_start: 'Earliest start',
  relocate: 'Relocate', travel: 'Travel', open_to_other_locations: 'Other locations', previously_employed: 'Worked there before',
  non_compete: 'Non-compete', heard_from: 'Heard from', talent_network: 'Talent network', gender: 'Gender',
  hispanic_latino: 'Hispanic or Latino', race: 'Race', veteran: 'Veteran', disability: 'Disability',
}

const show = (v: unknown) => (v === 'yes' ? 'Yes' : v === 'no' ? 'No' : String(v))

export function ReportedAnswersCard({ answers }: { answers: ApplicationAnswers }) {
  const stored = useApplicationAnswers()
  const save = useSaveApplicationAnswers()
  const [saved, setSaved] = useState(false)
  const rows = (Object.keys(LABELS) as (keyof ApplicationAnswers)[])
    .filter((k) => answers[k] !== null)
    .map((k) => [LABELS[k]!, show(answers[k])] as const)
  if (answers.preferred_locations.length) rows.push(['Preferred locations', answers.preferred_locations.join(' · ')] as const)
  const onSave = async () => {
    await save.mutateAsync(mergeAnswers(stored.data?.answers ?? EMPTY_ANSWERS, answers))
    setSaved(true)
  }

  return (
    <div style={{ borderRadius: 12, background: 'var(--surface)', boxShadow: 'var(--shadow-sm)', padding: '12px 14px', display: 'flex', flexDirection: 'column', gap: 8, marginTop: 8 }}>
      <div style={{ fontSize: 11, color: 'var(--fg-muted)', display: 'flex', alignItems: 'center', gap: 5 }}>
        <Icon name="puzzle" size={11} /> Application answers · {rows.length + answers.custom.length} read
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: 'minmax(120px, auto) 1fr', columnGap: 12, rowGap: 3, fontSize: 12.5 }}>
        {rows.map(([label, value]) => (
          <div key={label} style={{ display: 'contents' }}>
            <span style={{ color: 'var(--fg-muted)' }}>{label}</span><span>{value}</span>
          </div>
        ))}
      </div>
      {answers.custom.length > 0 && (
        <details style={{ fontSize: 12 }}>
          <summary style={{ cursor: 'pointer', color: 'var(--fg-muted)' }}>{answers.custom.length} other question{answers.custom.length === 1 ? '' : 's'}</summary>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 4, paddingTop: 6 }}>
            {answers.custom.map((c) => <div key={c.question}><span style={{ color: 'var(--fg-muted)' }}>{c.question}</span> — {c.answer}</div>)}
          </div>
        </details>
      )}
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
        {saved ? (
          <span style={{ ...muted, color: 'var(--fg)' }}><Icon name="check" size={12} /> Saved. <Link to="/extension">Review them on the Extension page</Link></span>
        ) : (
          <>
            <button type="button" className="btn-primary" disabled={save.isPending || stored.isLoading} onClick={onSave}>
              <Icon name="check" size={12} /> {save.isPending ? 'Saving…' : 'Save to my application answers'}
            </button>
            <span style={muted}>Replaces what it read, keeps the rest. Consent stays your own switch on the Extension page.</span>
          </>
        )}
      </div>
      {save.error && <div role="alert" style={{ ...muted, color: 'oklch(0.45 0.15 30)' }}>{(save.error as Error).message}</div>}
    </div>
  )
}
