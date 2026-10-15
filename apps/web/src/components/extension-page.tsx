// The Extension page (sidebar, under My Resume): everything the browser
// extension fills in for the user, managed in one place — whether it's
// connected here, which resume it uses, the files it uploads
// (components/application-files.tsx), the consent switch and the
// application answers (components/application-answers.tsx). The extension
// gets them over the page bridge (hooks/extension-bridge.ts).
import type { CSSProperties } from 'react'
import { Link } from 'react-router-dom'
import { Icon } from './primitives'
import { PageHeader } from './shell'
import { ApplicationAnswersPane } from './application-answers'
import { ApplicationFilesCard } from './application-files'
import { useExtension } from './apply-assist'
import { useCurrentResume } from '../hooks/resumes'

const muted: CSSProperties = { fontSize: 11.5, color: 'var(--fg-muted)', lineHeight: 1.55 }
const card: CSSProperties = { background: 'var(--surface)', borderRadius: 12, boxShadow: 'var(--shadow-sm)', padding: '16px 18px', display: 'flex', flexDirection: 'column', gap: 10 }

function StatusCard() {
  const ext = useExtension()
  const current = useCurrentResume().data
  const connected = !!ext.data
  return (
    <div style={card}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <span style={{ width: 8, height: 8, borderRadius: 999, background: ext.isLoading ? 'var(--fg-muted)' : connected ? 'oklch(0.62 0.15 155)' : 'oklch(0.7 0.15 70)' }} />
        <span style={{ fontSize: 14, fontWeight: 600, color: 'var(--fg)' }}>
          {ext.isLoading ? 'Looking for the extension…' : connected ? 'Extension connected in this browser' : 'No extension in this browser'}
        </span>
        {connected && <span style={{ ...muted, fontFamily: 'var(--font-mono)' }}>v{ext.data}</span>}
      </div>
      {connected ? (
        <div style={muted}>
          It fills with the resume you pick in the Landed menu bar ({current ? <Link to="/resumes">{current.name}</Link> : 'none marked current yet'}), or — when you
          start from a lead or application here — the version tailored for that job. Unknown fields go to the AI on your Mac (Ollama, or your Claude Code).
          It never clicks Submit.
        </div>
      ) : (
        <div style={{ ...muted, display: 'flex', flexDirection: 'column', gap: 6 }}>
          <span>Safari: install Landed for Mac — the extension comes with it — then turn it on in Safari Settings → Extensions.</span>
          <span>Chrome, Edge or Brave: Landed for Mac's menu has “Chromium Extension Folder”; load it once from the browser's extensions page.</span>
          <span>
            <a className="btn-secondary" href="/api/downloads/landed-mac.zip" download style={{ textDecoration: 'none', display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 12 }}>
              <Icon name="download" size={12} /> Download Landed for Mac
            </a>
          </span>
        </div>
      )}
    </div>
  )
}

export function ExtensionPage() {
  return (
    <>
      <PageHeader title="Extension" subtitle="What the browser extension fills in for you" />
      <div style={{ flex: 1, overflowY: 'auto', padding: '16px 28px 40px' }}>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12, maxWidth: 860 }}>
          <StatusCard />
          <ApplicationFilesCard />
          <ApplicationAnswersPane />
        </div>
      </div>
    </>
  )
}
