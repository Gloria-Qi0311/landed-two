// The application's candidate portal, in the detail drawer: its link, and a
// button that has the user's agent look up the status there — read-only, in
// their Chrome (lib/portal-check.ts, the same check the Agent page offers
// for quiet applications and Automation runs on a schedule). What it finds
// goes through the processor in ask-first mode. Replaces a mock-up that
// showed made-up sync states.
import { Icon } from './primitives'
import { formatRelative } from '../lib/time'
import { usePortalCheck } from '../lib/portal-check'
import { browserAgent, portalTarget } from '../hooks/portal'
import { useRuntimes } from '../hooks/runtimes'
import { useSuggestions } from '../hooks/inbox'
import { muted, danger } from './ui'

type App = { id: string; role: string; stage: string; portal_application_url: string | null }


const host = (url: string) => {
  try {
    return new URL(url).hostname.replace(/^www\./, '')
  } catch {
    return url
  }
}

export function PortalCard({ app, companyName }: { app: App; companyName: string }) {
  const runtimes = useRuntimes()
  const target = portalTarget(runtimes.data)
  const browser = browserAgent(runtimes.data)
  const check = usePortalCheck((s) => s.check)
  const start = usePortalCheck((s) => s.start)
  const suggestions = useSuggestions().data
  const url = app.portal_application_url
  const mine = check?.items.some((i) => i.application_id === app.id) ? check : null
  const running = check?.status === 'running'
  const last = (suggestions ?? [])
    .filter((s) => s.application_id === app.id && s.evidence?.source === 'portal')
    .sort((a, b) => b.created_at.localeCompare(a.created_at))[0]

  const blocker = !url
    ? 'Add the job link below (its candidate portal — Workday, Greenhouse, LinkedIn… — or the posting), and your agent can look up the status.'
    : !browser ? 'Needs Claude in Chrome connected to Claude Code on your computer.'
    : !target ? `${browser.runtime.name} is offline — start Landed on it to check.`
    : null

  let status: React.ReactNode = last
    ? <>Last check {formatRelative(last.created_at)}: “{last.evidence.subject ?? last.status}”{last.state === 'pending' ? ' — waiting for you on Applications' : ''}</>
    : 'Not checked yet.'
  if (mine?.status === 'running') status = <>Looking at it in Chrome…{mine.pages ? ` (${mine.pages} pages read)` : ''}</>
  if (mine?.status === 'error') status = <span style={{ color: danger }}>{mine.error}</span>
  if (mine?.status === 'done' && mine.result) {
    const r = mine.result
    status = r.login_required.length ? 'The portal wants you to sign in first. Sign in to it in Chrome, then check again — your agent never signs in.'
      : r.updated ? 'It shows the application as submitted — updated.'
      : r.needs_input ? 'It shows a new status — confirm it on Applications.'
      : r.in_process ? 'Still in process there.'
      : r.not_found.length ? "Your agent couldn't find this application's status there."
      : 'Nothing new.'
  }

  return (
    <div style={{ background: 'var(--surface-2)', borderRadius: 10, padding: '12px 14px', display: 'flex', flexDirection: 'column', gap: 8 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <Icon name="external" size={12} />
        <span style={{ fontSize: 12, fontWeight: 600, color: 'var(--fg)' }}>Candidate portal</span>
        {url && <span style={{ marginLeft: 'auto', fontSize: 11, color: 'var(--fg-muted)', fontFamily: 'var(--font-mono)' }}>{host(url)}</span>}
      </div>
      <div style={muted}>{status}</div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
        <button type="button" className="btn-secondary" disabled={!!blocker || running}
          onClick={() => target && url && start(target, [{ id: app.id, company: companyName, role: app.role, stage: app.stage, url }])}
          style={{ fontSize: 11.5, opacity: blocker || running ? 0.6 : 1 }}>
          <Icon name="search" size={11} /> {running && mine ? 'Checking…' : 'Check status now'}
        </button>
        <span style={muted}>{blocker ?? 'Read-only: your agent opens and reads the page in your Chrome, never clicks, types or signs in.'}</span>
      </div>
    </div>
  )
}
