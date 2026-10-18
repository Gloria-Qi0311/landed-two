// Empty states for new users — first-time experience for each module.
import React from 'react';
import { Icon } from './primitives';

export const EmptyApplicationsView = ({ onAddManual, onConnectPortal }: { onAddManual: () => void; onConnectPortal: () => void }) => (
  <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '40px 28px', overflowY: 'auto' }}>
    <div style={{ maxWidth: 760, width: '100%' }}>
      <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', textAlign: 'center', marginBottom: 28 }}>
        <div style={{ width: 56, height: 56, borderRadius: 14, background: 'var(--surface)', border: '0.5px solid var(--border)', display: 'flex', alignItems: 'center', justifyContent: 'center', marginBottom: 16, color: 'var(--fg-muted)' }}>
          <Icon name="inbox" size={28} stroke={1.5} />
        </div>
        <div style={{ fontSize: 20, fontWeight: 600, letterSpacing: '-0.02em', fontFamily: 'var(--font-display)', marginBottom: 6 }}>
          No applications yet
        </div>
        <div style={{ fontSize: 13, color: 'var(--fg-muted)', lineHeight: 1.55, maxWidth: 480 }}>
          Track everything you've applied to in one pipeline. Start with either path —
          you can mix both later.
        </div>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
        <button onClick={onConnectPortal} style={{
          background: 'var(--surface)', border: '0.5px solid var(--border)',
          borderRadius: 10, padding: 18, textAlign: 'left', cursor: 'pointer',
          fontFamily: 'inherit', color: 'var(--fg)',
        }} className="kanban-card">
          <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 10 }}>
            <Icon name="refresh" size={16} />
            <span style={{ fontSize: 11, color: 'oklch(0.45 0.13 155)', background: 'oklch(0.96 0.04 155)', padding: '2px 7px', borderRadius: 4, fontWeight: 500, letterSpacing: '0.02em' }}>RECOMMENDED</span>
          </div>
          <div style={{ fontSize: 14, fontWeight: 600, marginBottom: 4 }}>Connect a portal</div>
          <div style={{ fontSize: 12, color: 'var(--fg-muted)', lineHeight: 1.5, marginBottom: 14 }}>
            Auto-import every role you've applied to on Greenhouse, Lever, Workday, Ashby, BOSS Zhipin, and more. Status changes flow back automatically.
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 6, color: 'var(--fg)', fontSize: 12, fontWeight: 500 }}>
            Install extension <Icon name="arrowRight" size={11} />
          </div>
        </button>

        <button onClick={onAddManual} style={{
          background: 'var(--surface)', border: '0.5px solid var(--border)',
          borderRadius: 10, padding: 18, textAlign: 'left', cursor: 'pointer',
          fontFamily: 'inherit', color: 'var(--fg)',
        }} className="kanban-card">
          <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 10, height: 24 }}>
            <Icon name="plus" size={16} stroke={2} />
          </div>
          <div style={{ fontSize: 14, fontWeight: 600, marginBottom: 4 }}>Add manually</div>
          <div style={{ fontSize: 12, color: 'var(--fg-muted)', lineHeight: 1.5, marginBottom: 14 }}>
            Paste a job URL or fill the form. We'll fetch the company, parse the role title, and pre-fill what we can.
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 6, color: 'var(--fg)', fontSize: 12, fontWeight: 500 }}>
            Add an application <Icon name="arrowRight" size={11} />
          </div>
        </button>
      </div>

      <div style={{ marginTop: 16, padding: 14, background: 'var(--surface-2)', border: '0.5px solid var(--border)', borderRadius: 8, display: 'flex', alignItems: 'flex-start', gap: 10 }}>
        <div style={{ width: 22, height: 22, borderRadius: 11, background: 'var(--surface)', border: '0.5px solid var(--border)', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0, marginTop: 1 }}>
          <Icon name="doc" size={12} />
        </div>
        <div style={{ flex: 1 }}>
          <div style={{ fontSize: 12.5, fontWeight: 600, color: 'var(--fg)', marginBottom: 2 }}>Coming from a spreadsheet?</div>
          <div style={{ fontSize: 11.5, color: 'var(--fg-muted)', lineHeight: 1.5 }}>
            Import a CSV — we'll map columns to fields and merge duplicates by company + role.
          </div>
        </div>
        <button className="btn-secondary" style={{ fontSize: 11.5, flexShrink: 0 }}>
          Import CSV
        </button>
      </div>
    </div>
  </div>
);
