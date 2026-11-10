// Connector — the small Landed program on the user's computer (apps/daemon)
// that hands Landed's AI work (reading a resume, searching, checking email,
// writing answers) to the agent they already use: Claude Code, Codex…, on
// their own subscription. Here they connect a computer, see which agents it
// found, and disconnect one. Old /agent links land here.
import { PageHeader } from './shell'
import { RuntimePanel } from './runtime-panel'

export function ConnectorPage() {
  return (
    <>
      <PageHeader title="Connector" subtitle="Your own AI agent, on your computer, does Landed's AI work" />
      <div style={{ flex: 1, overflowY: 'auto', padding: '16px 28px' }}>
        <div style={{ width: '100%', maxWidth: 760, margin: '0 auto', display: 'flex', flexDirection: 'column', gap: 12 }}>
          <RuntimePanel />
        </div>
      </div>
    </>
  )
}
