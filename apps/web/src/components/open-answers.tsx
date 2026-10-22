// The open-ended answers an application was sent with ("Why us?"): the user's
// own agent wrote them during the fill (lib/open-answers.ts). The user can
// read and change each; a changed one is theirs, and the agent follows it as
// an example of their voice next time.
import type { OpenAnswer } from '@landed/schema/open-answers'
import { EditableText } from './editable'
import { editOpenAnswer } from '../lib/open-answers'

export function OpenAnswers({ answers, onSave }: { answers: OpenAnswer[] | null; onSave: (next: OpenAnswer[]) => void }) {
  if (!answers?.length) return null
  return (
    <div style={{ marginBottom: 18 }}>
      <div style={{ fontSize: 11, fontWeight: 500, color: 'var(--fg-muted)', textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: 2 }}>Answers sent</div>
      <div style={{ fontSize: 11, color: 'var(--fg-muted)', marginBottom: 6, lineHeight: 1.4 }}>
        Your agent wrote these from the posting and your resume. Edit one and Landed follows your version next time.
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
        {answers.map((a, i) => (
          <div key={`${i}-${a.question}`}>
            <div style={{ fontSize: 12, fontWeight: 500, marginBottom: 3 }}>
              {a.question}
              {a.edited && <span style={{ fontWeight: 400, color: 'var(--fg-muted)' }}> · edited</span>}
            </div>
            <div style={{ fontSize: 12.5, padding: 10, background: 'var(--surface-2)', borderRadius: 6, border: '0.5px solid var(--border)', lineHeight: 1.5, whiteSpace: 'pre-wrap' }}>
              <EditableText label={`answer to “${a.question}”`} multiline value={a.answer} placeholder="(empty)"
                onSave={(text) => { if (text.trim() && text.trim() !== a.answer) onSave(editOpenAnswer(answers, i, text)) }} />
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}
