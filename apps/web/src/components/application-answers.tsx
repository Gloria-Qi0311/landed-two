// "Application answers" on My Resume: what forms ask that a resume doesn't.
// Filled in once (by hand, or by the agent reading a form the user already
// filled — components/reported-answers.tsx); the extension uses them when it
// fills a form, radio buttons and dropdowns included
// (apps/extension/lib/choice-answers.js). Blank means "leave it for me",
// except the voluntary EEO questions, where blank means "I don't wish to
// answer". Consent is ticked only with its own switch on; Submit is never
// clicked.
import { useEffect, useState, type CSSProperties, type ReactNode } from 'react'
import { answeredCount, EMPTY_ANSWERS, type ApplicationAnswers, type YesNo } from '@landed/schema/application-answers'
import { Icon } from './primitives'
import { useApplicationAnswers, useSaveApplicationAnswers } from '../hooks/answers'
import { muted, card as baseCard } from './ui'

const card: CSSProperties = { ...baseCard, gap: 12 }
const rowStyle: CSSProperties = { display: 'grid', gridTemplateColumns: 'minmax(180px, 1fr) minmax(220px, 1.3fr)', gap: 12, alignItems: 'center', padding: '8px 0', borderTop: '1px solid var(--border-subtle)' }
const input: CSSProperties = { width: '100%', fontSize: 12.5 }

type TextKey = { [K in keyof ApplicationAnswers]: ApplicationAnswers[K] extends string | null ? K : never }[keyof ApplicationAnswers]
type YesNoKey = { [K in keyof ApplicationAnswers]: ApplicationAnswers[K] extends YesNo | null ? (YesNo | null extends ApplicationAnswers[K] ? K : never) : never }[keyof ApplicationAnswers]

function Row({ label, help, children }: { label: string; help?: string; children: ReactNode }) {
  return (
    <div style={rowStyle}>
      <div>
        <div style={{ fontSize: 12.5, color: 'var(--fg)', fontWeight: 500 }}>{label}</div>
        {help && <div style={muted}>{help}</div>}
      </div>
      <div>{children}</div>
    </div>
  )
}

function Segmented<T extends string | null>({ value, options, onChange }: { value: T; options: [T, string][]; onChange: (v: T) => void }) {
  return (
    <div role="radiogroup" style={{ display: 'inline-flex', background: 'var(--surface-2)', borderRadius: 8, padding: 2, gap: 2, flexWrap: 'wrap' }}>
      {options.map(([v, text]) => (
        <button key={text} type="button" role="radio" aria-checked={value === v} onClick={() => onChange(v)} style={{
          border: 'none', borderRadius: 6, padding: '4px 12px', fontSize: 12, cursor: 'pointer', fontFamily: 'inherit',
          background: value === v ? 'var(--surface)' : 'transparent', boxShadow: value === v ? 'var(--shadow-sm)' : 'none',
          color: value === v ? 'var(--fg)' : 'var(--fg-muted)', fontWeight: value === v ? 600 : 400,
        }}>{text}</button>
      ))}
    </div>
  )
}

function Section({ title, note, children }: { title: string; note?: ReactNode; children: ReactNode }) {
  return (
    <section style={{ display: 'flex', flexDirection: 'column' }}>
      <div style={{ fontSize: 11, fontWeight: 600, color: 'var(--fg-muted)', textTransform: 'uppercase', letterSpacing: '0.05em', padding: '10px 0 6px' }}>{title}</div>
      {note && <div style={{ ...muted, paddingBottom: 6 }}>{note}</div>}
      {children}
    </section>
  )
}

export function ApplicationAnswersPane() {
  const stored = useApplicationAnswers()
  const save = useSaveApplicationAnswers()
  const [draft, setDraft] = useState<ApplicationAnswers>(EMPTY_ANSWERS)
  const [dirty, setDirty] = useState(false)
  useEffect(() => {
    if (!dirty && stored.data !== undefined) setDraft(stored.data?.answers ?? EMPTY_ANSWERS)
  }, [stored.data, dirty])

  const update = (patch: Partial<ApplicationAnswers>) => {
    setDraft((d) => ({ ...d, ...patch }))
    setDirty(true)
  }
  const text = (key: TextKey, placeholder: string) => (
    <input type="text" value={draft[key] ?? ''} placeholder={placeholder} style={input}
      onChange={(e) => update({ [key]: e.target.value || null })} />
  )
  const yesNo = (key: YesNoKey, unset = 'Ask me') => (
    <Segmented<YesNo | null> value={draft[key]} options={[['yes', 'Yes'], ['no', 'No'], [null, unset]]} onChange={(v) => update({ [key]: v })} />
  )
  const location = (i: number) => (
    <input type="text" value={draft.preferred_locations[i] ?? ''} placeholder={['e.g. San Francisco, CA', 'e.g. Seattle, WA', 'e.g. Los Angeles, CA'][i]} style={input}
      onChange={(e) => {
        const next = [...draft.preferred_locations]
        next[i] = e.target.value
        update({ preferred_locations: next.slice(0, 3) })
      }} />
  )
  const onSave = async () => {
    await save.mutateAsync({
      ...draft,
      preferred_locations: draft.preferred_locations.map((l) => l?.trim()).filter(Boolean),
      custom: draft.custom.filter((c) => c.question.trim() && c.answer.trim()),
    })
    setDirty(false)
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12, maxWidth: 860 }}>
      <div style={card}>
        <div style={{ display: 'flex', alignItems: 'flex-start', gap: 12 }}>
          <div style={{ flex: 1 }}>
            <div style={{ fontSize: 15, fontWeight: 600, color: 'var(--fg)' }}>Application answers</div>
            <div style={muted}>
              What application forms ask that your resume doesn't. The extension uses these when it fills a form — text fields, radio buttons and
              dropdowns. Anything left on “Ask me” stays yellow for you, and it never clicks Submit. Quicker: send your agent a screenshot of a form
              you already filled and ask it to save your answers.
            </div>
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexShrink: 0 }}>
            <span style={muted}>{save.isPending ? 'Saving…' : dirty ? 'Unsaved changes' : `${answeredCount(draft)} answered`}</span>
            <button type="button" className="btn-primary" disabled={!dirty || save.isPending} onClick={onSave} style={{ opacity: !dirty || save.isPending ? 0.45 : 1 }}>
              <Icon name="check" size={12} /> Save
            </button>
          </div>
        </div>
        {save.error && <div role="alert" style={{ ...muted, color: 'oklch(0.45 0.15 30)' }}>{(save.error as Error).message}</div>}

        <Section title="Consent">
          <Row label="Tick consent boxes for me" help="Privacy policy, data processing, “I confirm I have read…”. Off: they stay yellow for you.">
            <input type="checkbox" className="switch" checked={draft.agree_to_terms} aria-label="Tick consent boxes for me"
              onChange={(e) => update({ agree_to_terms: e.target.checked })} />
          </Row>
        </Section>

        <Section title="Name" note="Legal names go to “First / Last name” fields, preferred ones to “Preferred name”. Blank: the name on your resume.">
          <Row label="Legal first name">{text('legal_first_name', 'As on your ID')}</Row>
          <Row label="Legal middle name">{text('legal_middle_name', 'If you have one')}</Row>
          <Row label="Legal last name">{text('legal_last_name', 'As on your ID')}</Row>
          <Row label="Preferred first name" help="Only if different; forms asking “Has preferred name?” get Yes.">{text('preferred_first_name', 'e.g. Alex')}</Row>
          <Row label="Preferred last name">{text('preferred_last_name', '')}</Row>
          <Row label="Date of birth" help="Some employers ask for day and month for background checks.">{text('date_of_birth', 'e.g. October 30')}</Row>
        </Section>

        <Section title="Links" note="For “LinkedIn profile”, “GitHub” and “Website” fields — full links, even if your resume only names them.">
          <Row label="LinkedIn">{text('linkedin', 'https://www.linkedin.com/in/…')}</Row>
          <Row label="GitHub">{text('github', 'https://github.com/…')}</Row>
          <Row label="Website / portfolio">{text('website', 'https://…')}</Row>
        </Section>

        <Section title="Permanent address">
          <Row label="Address line 1">{text('address_line1', 'Street address')}</Row>
          <Row label="Address line 2">{text('address_line2', 'Apt, suite (optional)')}</Row>
          <Row label="City">{text('city', 'e.g. Seattle')}</Row>
          <Row label="State / province">{text('state', 'e.g. Washington')}</Row>
          <Row label="ZIP / postal code">{text('postal_code', 'e.g. 98105')}</Row>
          <Row label="Country" help="Also answers “are you a resident of…” questions.">{text('country', 'e.g. United States')}</Row>
        </Section>

        <Section title="Work eligibility">
          <Row label="18 years of age or older?">{yesNo('adult')}</Row>
          <Row label="Legally authorized to work in the US?" help="Or the country of the job.">{yesNo('work_authorized')}</Row>
          <Row label="Need visa sponsorship, now or later?" help="Includes OPT / STEM OPT / CPT that will need H-1B.">{yesNo('needs_sponsorship')}</Row>
        </Section>

        <Section title="Availability and location">
          <Row label="Earliest full-time start">{text('earliest_start', 'e.g. June 2027')}</Row>
          <Row label="Willing to relocate?">{yesNo('relocate')}</Row>
          <Row label="Willing to travel?">{yesNo('travel')}</Row>
          <Row label="Open to working onsite?" help="In the office every day, e.g. “5 days a week” questions.">{yesNo('onsite')}</Row>
          <Row label="Preferred locations" help="First, second and third choice.">
            <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>{location(0)}{location(1)}{location(2)}</div>
          </Row>
          <Row label="Open to other locations?" help="If your preferred ones aren't available.">{yesNo('open_to_other_locations')}</Row>
        </Section>

        <Section title="Background">
          <Row label="Worked at the company before?" help="Yes for the companies on your resume, whatever you pick here; this is the answer for every other company — usually No.">{yesNo('previously_employed')}</Row>
          <Row label="Bound by a non-compete?">{yesNo('non_compete')}</Row>
          <Row label="How you heard about the job">{text('heard_from', 'e.g. Company careers website, LinkedIn')}</Row>
          <Row label="Join the talent network / job alerts?">{yesNo('talent_network')}</Row>
        </Section>

        <Section title="Voluntary self-identification (US EEO)" note="Optional on every form. “Don't answer” picks “I don't wish to answer”.">
          <Row label="Gender">
            <Segmented<string | null> value={draft.gender} options={[['Male', 'Male'], ['Female', 'Female'], ['Non-binary', 'Non-binary'], [null, "Don't answer"]]}
              onChange={(v) => update({ gender: v })} />
          </Row>
          <Row label="Hispanic or Latino?">{yesNo('hispanic_latino', "Don't answer")}</Row>
          <Row label="Race">{text('race', "e.g. Asian — blank: don't answer")}</Row>
          <Row label="Veteran?">{yesNo('veteran', "Don't answer")}</Row>
          <Row label="Disability?">{yesNo('disability', "Don't answer")}</Row>
        </Section>

        <Section title="Other questions" note="Anything else forms keep asking. Your local AI matches a form's question to these and picks the option that fits.">
          {draft.custom.map((c, i) => (
            <div key={i} style={{ ...rowStyle, gridTemplateColumns: 'minmax(180px, 1fr) minmax(220px, 1.3fr) auto' }}>
              <input type="text" value={c.question} placeholder="Question, e.g. Experience in data analytics?" style={input}
                onChange={(e) => update({ custom: draft.custom.map((x, j) => (j === i ? { ...x, question: e.target.value } : x)) })} />
              <input type="text" value={c.answer} placeholder="Your answer" style={input}
                onChange={(e) => update({ custom: draft.custom.map((x, j) => (j === i ? { ...x, answer: e.target.value } : x)) })} />
              <button type="button" className="btn-ghost" aria-label="Remove" onClick={() => update({ custom: draft.custom.filter((_, j) => j !== i) })}>
                <Icon name="x" size={12} />
              </button>
            </div>
          ))}
          <div style={{ paddingTop: 8 }}>
            <button type="button" className="btn-secondary" onClick={() => update({ custom: [...draft.custom, { question: '', answer: '' }] })}>
              <Icon name="plus" size={12} /> Add a question
            </button>
          </div>
        </Section>
      </div>
    </div>
  )
}
