// /authorize-agent — the OAuth consent page cloud agents (ChatGPT, Claude,
// Gemini…) send the user to when they connect Landed as a connector
// (apps/server/src/routes/oauth.ts). Signed-in only (the login screen comes
// first). Shows who is asking and exactly what it can do, then sends the
// user back to the agent with a one-time code — or with "access denied".
import { useEffect, useState } from 'react'
import { api, ApiError } from '../lib/api'
import { useAuth } from '../lib/auth'

const PARAMS = ['client_id', 'redirect_uri', 'response_type', 'code_challenge', 'code_challenge_method', 'state', 'scope', 'resource']

export function AuthorizeAgentPage() {
  const user = useAuth((s) => s.user)!
  const [query] = useState(() => {
    const p = new URLSearchParams(window.location.search)
    return Object.fromEntries(PARAMS.filter((k) => p.has(k)).map((k) => [k, p.get(k)!]))
  })
  const [info, setInfo] = useState<{ client_name: string; redirect_host: string } | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    api.get<{ client_name: string; redirect_host: string }>(`/oauth/authorize-info?${new URLSearchParams(query)}`)
      .then(setInfo, (e) => setError(e instanceof ApiError ? e.message : 'Landed could not check this request.'))
  }, [query])

  const decide = async (decision: 'allow' | 'deny') => {
    setBusy(true)
    try {
      const { redirect } = await api.post<{ redirect: string }>('/oauth/approve', { ...query, decision })
      window.location.href = redirect
    } catch (e) {
      setError((e as Error).message)
      setBusy(false)
    }
  }

  const name = info?.client_name ?? 'This app'
  return (
    <div style={{ minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center', background: 'var(--bg)', padding: 16 }}>
      <div style={{ width: '100%', maxWidth: 460, background: 'var(--surface)', border: '0.5px solid var(--border)', borderRadius: 12, padding: 24, display: 'flex', flexDirection: 'column', gap: 14 }}>
        <div style={{ fontSize: 12, color: 'var(--fg-muted)' }}>Landed · signed in as {user.email}</div>
        {error ? (
          <>
            <div style={{ fontSize: 16, fontWeight: 600 }}>Can't connect</div>
            <div role="alert" style={{ fontSize: 13, color: 'oklch(0.45 0.15 30)', lineHeight: 1.55 }}>{error}</div>
            <a href="/agent?view=settings" className="btn-secondary" style={{ alignSelf: 'flex-start' }}>Go to Landed</a>
          </>
        ) : !info ? (
          <div style={{ fontSize: 13, color: 'var(--fg-muted)' }}>Checking the request…</div>
        ) : (
          <>
            <div style={{ fontSize: 17, fontWeight: 600, lineHeight: 1.35 }}>Connect {name} to Landed?</div>
            <div style={{ fontSize: 13, lineHeight: 1.6 }}>
              {name} becomes one of your agents. It runs in the cloud on your own subscription, whenever you ask it or on its own schedule. It can:
            </div>
            <ul style={{ margin: 0, paddingLeft: 18, fontSize: 13, lineHeight: 1.7 }}>
              <li>read the search direction you confirmed with Landed's agent, search for jobs, and add what it finds to your <b>Leads</b></li>
              <li>if you turned email checks on, report what your job-application emails say (only if it can read your mail itself, e.g. its Gmail connector)</li>
              <li>see the company, role and stage of your applications, so it recognizes them in email</li>
            </ul>
            <div style={{ fontSize: 12, color: 'var(--fg-muted)', lineHeight: 1.6 }}>
              It can't change or delete anything: Landed decides what its reports mean, as with every agent.
              {!user.cloud_sync && " Your data stays on this device; while a cloud agent is connected, this browser shares only your search direction and application list (company, role, stage) with Landed's server so the agent can read them."}
              {' '}Disconnect it any time in Agent → Settings; that deletes what was shared.
            </div>
            <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', alignItems: 'center' }}>
              <span style={{ fontSize: 11.5, color: 'var(--fg-muted)', marginRight: 'auto' }}>Returns to {info.redirect_host}</span>
              <button className="btn-secondary" disabled={busy} onClick={() => decide('deny')}>Cancel</button>
              <button className="btn-primary" disabled={busy} onClick={() => decide('allow')}>{busy ? 'Connecting…' : 'Allow'}</button>
            </div>
          </>
        )}
      </div>
    </div>
  )
}
