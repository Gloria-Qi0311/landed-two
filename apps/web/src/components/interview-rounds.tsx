// Interview rounds on an application (detail drawer): which round, when,
// onsite or remote, and who interviewed you — tag any mix of peer,
// teammate, leader, HR. The next round (or the latest) shows on the
// Interview card. Times also arrive on their own from interview emails.
// Shape + validation: packages/schema/src/pipeline.ts.
import { INTERVIEWER_LABEL, INTERVIEWERS, type InterviewRound, type Interviewer } from '@landed/schema/pipeline'
import { Icon } from './primitives'

const chip = (on: boolean) => ({
  padding: '2px 8px', borderRadius: 999, fontSize: 11, fontWeight: 500, cursor: 'pointer',
  fontFamily: 'inherit', display: 'inline-flex', alignItems: 'center', gap: 4,
  background: on ? 'oklch(0.96 0.04 305)' : 'transparent',
  color: on ? 'oklch(0.44 0.14 305)' : 'var(--fg-muted)',
  border: `0.5px solid ${on ? 'oklch(0.88 0.06 305)' : 'var(--border)'}`,
}) as const

export function InterviewRounds({ rounds, onChange }: {
  rounds: InterviewRound[]
  onChange: (next: InterviewRound[]) => void
}) {
  const set = (i: number, patch: Partial<InterviewRound>) => onChange(rounds.map((r, j) => (j === i ? { ...r, ...patch } : r)))
  const toggle = (i: number, who: Interviewer) => {
    const has = rounds[i].interviewers.includes(who)
    // keep the canonical order so labels read the same everywhere
    set(i, { interviewers: INTERVIEWERS.filter((x) => (x === who ? !has : rounds[i].interviewers.includes(x))) })
  }
  const add = () => {
    const last = Math.max(0, ...rounds.map((r) => r.round ?? 0))
    onChange([...rounds, { round: last + 1, format: null, interviewers: [], at: null, note: null }])
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
      {rounds.map((r, i) => (
        <div key={i} style={{ border: '0.5px solid var(--border)', borderRadius: 8, padding: '8px 10px', display: 'flex', flexDirection: 'column', gap: 7, background: 'var(--surface-2)' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <label style={{ fontSize: 11.5, color: 'var(--fg-muted)', display: 'flex', alignItems: 'center', gap: 5 }}>
              Round
              <input type="number" min={1} max={50} value={r.round ?? ''} placeholder="?"
                onChange={(e) => set(i, { round: e.target.value ? Math.max(1, Math.min(50, Number(e.target.value))) : null })}
                style={{ width: 44, padding: '2px 6px', fontSize: 12, fontFamily: 'inherit' }} />
            </label>
            <div style={{ display: 'flex', gap: 4 }}>
              {(['onsite', 'remote'] as const).map((f) => (
                <button key={f} type="button" style={chip(r.format === f)} onClick={() => set(i, { format: r.format === f ? null : f })}>
                  <Icon name={f === 'onsite' ? 'map' : 'device'} size={10} /> {f === 'onsite' ? 'Onsite' : 'Remote'}
                </button>
              ))}
            </div>
            <button type="button" title="Remove this round" aria-label="Remove this round" className="icon-btn"
              onClick={() => onChange(rounds.filter((_, j) => j !== i))}
              style={{ marginLeft: 'auto', background: 'transparent', border: 'none', color: 'var(--fg-muted)', cursor: 'pointer', padding: 2, display: 'flex' }}>
              <Icon name="x" size={12} />
            </button>
          </div>
          <label style={{ fontSize: 11.5, color: 'var(--fg-muted)', display: 'flex', alignItems: 'center', gap: 6 }}>
            When
            <input type="datetime-local" value={toLocalInput(r.at)} aria-label="Interview time"
              onChange={(e) => set(i, { at: e.target.value ? new Date(e.target.value).toISOString() : null })}
              style={{ fontSize: 12, fontFamily: 'inherit', padding: '2px 6px' }} />
          </label>
          <div style={{ display: 'flex', alignItems: 'center', gap: 4, flexWrap: 'wrap' }}>
            <span style={{ fontSize: 11.5, color: 'var(--fg-muted)', marginRight: 2 }}>With</span>
            {INTERVIEWERS.map((who) => (
              <button key={who} type="button" style={chip(r.interviewers.includes(who))} onClick={() => toggle(i, who)}>
                {INTERVIEWER_LABEL[who]}
              </button>
            ))}
          </div>
        </div>
      ))}
      <div>
        <button type="button" className="btn-secondary" onClick={add} style={{ fontSize: 11.5 }}>
          <Icon name="plus" size={11} /> Add round
        </button>
      </div>
    </div>
  )
}

/** ISO time → the value a datetime-local input wants, in local time. */
function toLocalInput(iso: string | null): string {
  if (!iso || Number.isNaN(Date.parse(iso))) return ''
  const d = new Date(iso)
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`
}
