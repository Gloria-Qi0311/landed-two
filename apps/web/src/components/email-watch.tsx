// Email watching on the Agent page: a status strip in the chat (turn it
// on / last check / "Check now") and the setting in Agent settings. The
// agent reads mail through its own connector; see hooks/email.ts.
import { Icon } from './primitives'
import { formatRelative } from '../lib/time'
import { useAuth } from '../lib/auth'
import { useEmailCheck, type EmailCheck } from '../lib/email-check'
import type { EmailIngestResult } from '../lib/inbox'
import { useAccountPrefs } from '../hooks/inbox'
import { useCheckEmail, useSetEmailWatch } from '../hooks/email'
import { canRun, useRuntimes, type Runtime } from '../hooks/runtimes'

const muted = { fontSize: 11.5, color: 'var(--fg-muted)', lineHeight: 1.5 } as const
const danger = 'oklch(0.45 0.15 30)'

/** An agent that can read mail, on any paired computer (online or not). */
function mailAgent(runtimes: Runtime[] | undefined) {
  for (const runtime of runtimes ?? []) {
    if (runtime.revoked_at) continue
    const agent = runtime.agents.find((a) => a.mail && canRun(a, 'email_check'))
    if (agent) return { runtime, agent, mail: agent.mail! }
  }
  return null
}

function resultText(r: EmailIngestResult) {
  const parts = [
    r.updated && `${r.updated} updated`,
    r.added && `${r.added} added`,
    r.needs_input && `${r.needs_input} need${r.needs_input === 1 ? 's' : ''} you`,
  ].filter(Boolean)
  return parts.length ? parts.join(', ') : 'nothing new'
}

function statusLine(check: EmailCheck | null, mail: string, checkedAt: string | null) {
  if (check?.status === 'running') return `Reading your ${mail}…${check.reads ? ` (${check.reads} looked at)` : ''}`
  if (check?.status === 'error') return `Email check failed: ${check.error}`
  if (check?.status === 'done' && check.result) return `${mail} checked ${formatRelative(check.started_at)} — ${resultText(check.result)}`
  return checkedAt ? `${mail} checked ${formatRelative(checkedAt)}` : 'Not checked yet'
}

function useEmailState() {
  const runtimes = useRuntimes()
  const prefs = useAccountPrefs()
  const check = useEmailCheck((s) => s.check)
  const now = useCheckEmail()
  const set = useSetEmailWatch()
  const offline = useAuth((s) => s.offline || s.unreachable)
  return {
    capable: mailAgent(runtimes.data),
    target: now.target,
    watch: !!prefs.data?.email_watch,
    checkedAt: prefs.data?.email_checked_at ?? null,
    loaded: !!prefs.data,
    check,
    running: check?.status === 'running',
    checkNow: now.run,
    set,
    offline,
  }
}

/** Strip at the top of the chat. Nothing to show until an agent can read mail. */
export function EmailStatus() {
  const s = useEmailState()
  if (!s.capable || !s.target || !s.loaded || s.offline) return null
  return (
    <div style={{ padding: '10px 14px', border: '0.5px solid var(--border)', borderRadius: 10, background: 'var(--surface-2)', display: 'flex', gap: 10, alignItems: 'center' }}>
      <span style={{ color: s.running ? 'var(--accent)' : 'var(--fg-muted)', display: 'flex', animation: s.running ? 'pulse 1.6s ease-in-out infinite' : undefined }}>
        <Icon name="inbox" size={13} />
      </span>
      <div style={{ minWidth: 0, flex: 1 }}>
        {s.watch ? (
          <div style={{ ...muted, color: s.check?.status === 'error' ? danger : muted.color }}>{statusLine(s.check, s.capable.mail, s.checkedAt)}</div>
        ) : (
          <div style={muted}>
            {s.capable.agent.label} can read your {s.capable.mail} and keep your applications' status up to date.
          </div>
        )}
      </div>
      {s.watch ? (
        <button type="button" className="btn-secondary" disabled={s.running} onClick={() => void s.checkNow()}
          style={{ flexShrink: 0, padding: '3px 8px', fontSize: 11.5, opacity: s.running ? 0.6 : 1 }}>
          Check now
        </button>
      ) : (
        <button type="button" className="btn-primary" disabled={s.set.isPending} onClick={() => s.set.mutate(true)}
          style={{ flexShrink: 0, padding: '3px 10px', fontSize: 11.5 }}>
          Turn on
        </button>
      )}
    </div>
  )
}

/** The Agent settings section. */
export function EmailWatchSetting() {
  const s = useEmailState()
  if (!s.capable) {
    return (
      <div style={muted}>
        Your agent can't read email yet. To let it keep your board up to date from application emails, connect Gmail in
        Claude (claude.ai → Settings → Connectors → Gmail); the daemon picks it up within 30 minutes (or right away if you restart it with <code>pnpm landed start</code>).
        Landed only ever asks it to read — never to send, label or delete.
      </div>
    )
  }
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
      <label style={{ display: 'flex', alignItems: 'flex-start', gap: 10, fontSize: 12, lineHeight: 1.5, cursor: 'pointer' }}>
        <input type="checkbox" checked={s.watch} disabled={s.offline || !s.loaded || s.set.isPending}
          onChange={(e) => s.set.mutate(e.target.checked)} style={{ marginTop: 2 }} />
        <span>
          <span style={{ fontWeight: 500 }}>Let {s.capable.agent.label} check my {s.capable.mail} for application updates</span>
          <span style={{ display: 'block', color: 'var(--fg-muted)' }}>
            Every few hours while Landed is open, it reads the emails since the last check, read-only, and reports confirmations,
            assessments, interviews, rejections and offers. The emails stay between your mailbox and {s.capable.runtime.name};
            only what it found passes through Landed.
          </span>
        </span>
      </label>
      {s.watch && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <span style={{ ...muted, flex: 1, color: s.check?.status === 'error' ? danger : muted.color }}>
            {statusLine(s.check, s.capable.mail, s.checkedAt)}
            {!s.target && ` · ${s.capable.runtime.name} is offline`}
          </span>
          <button type="button" className="btn-secondary" disabled={s.running || !s.target} onClick={() => void s.checkNow()}
            style={{ opacity: s.running || !s.target ? 0.6 : 1 }}>
            Check now
          </button>
        </div>
      )}
      {s.check?.summary && s.check.status === 'done' && <div style={muted}>{s.check.summary}</div>}
      {s.set.error && <div role="alert" style={{ ...muted, color: danger }}>{(s.set.error as Error).message}</div>}
    </div>
  )
}
