// Empty states for new users — first-time experience for each module.
import React from 'react';
import { Icon } from './primitives';

export const EmptyApplicationsView = ({ onAddManual, onConnectPortal }) => (
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

export const EmptySyncView = ({ onInstall }) => (
  <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '40px 28px', overflowY: 'auto' }}>
    <div style={{ maxWidth: 720, width: '100%' }}>
      <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', textAlign: 'center', marginBottom: 24 }}>
        <div style={{ width: 56, height: 56, borderRadius: 14, background: 'var(--surface)', border: '0.5px solid var(--border)', display: 'flex', alignItems: 'center', justifyContent: 'center', marginBottom: 16, color: 'var(--fg-muted)', position: 'relative' }}>
          <Icon name="refresh" size={26} stroke={1.5} />
          <span style={{ position: 'absolute', bottom: -4, right: -4, width: 18, height: 18, borderRadius: 9, background: 'var(--bg)', border: '0.5px solid var(--border)', display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'oklch(0.5 0.16 30)' }}>
            <Icon name="alert" size={11} stroke={2.5} />
          </span>
        </div>
        <div style={{ fontSize: 20, fontWeight: 600, letterSpacing: '-0.02em', fontFamily: 'var(--font-display)', marginBottom: 6 }}>
          Install the browser extension to enable auto-sync
        </div>
        <div style={{ fontSize: 13, color: 'var(--fg-muted)', lineHeight: 1.55, maxWidth: 520 }}>
          Without the extension, you'd have to update each application's status manually. The extension piggybacks on your existing portal logins — nothing to sign in to twice.
        </div>
      </div>

      <div style={{ background: 'var(--surface)', border: '0.5px solid var(--border)', borderRadius: 10, padding: 18 }}>
        <div style={{ fontSize: 11, fontWeight: 600, color: 'var(--fg-muted)', textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: 12 }}>Supported portals</div>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 6, marginBottom: 16 }}>
          {['Greenhouse', 'Lever', 'Workday', 'Ashby', 'BambooHR', 'SmartRecruiters', 'BOSS Zhipin', '+ more'].map(p => (
            <div key={p} style={{ padding: '7px 10px', background: 'var(--surface-2)', border: '0.5px solid var(--border)', borderRadius: 5, fontSize: 11.5, textAlign: 'center', color: p === '+ more' ? 'var(--fg-muted)' : 'var(--fg)', fontWeight: 500 }}>{p}</div>
          ))}
        </div>
        <div style={{ display: 'flex', gap: 8 }}>
          <button onClick={onInstall} className="btn-primary" style={{ flex: 1, justifyContent: 'center', padding: '8px 12px' }}>
            <Icon name="external" size={13} /> Install for Chrome
          </button>
          <a href="how-it-works.html" target="_blank" rel="noopener" className="btn-secondary" style={{ flex: 1, justifyContent: 'center', padding: '8px 12px', textDecoration: 'none' }}>
            <Icon name="doc" size={13} /> See how it works
          </a>
        </div>
      </div>
    </div>
  </div>
);

export const EmptyResumeMatchView = ({ onUploadResume, onAddJD }) => (
  <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '40px 28px', overflowY: 'auto' }}>
    <div style={{ maxWidth: 720, width: '100%' }}>
      <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', textAlign: 'center', marginBottom: 24 }}>
        <div style={{ width: 56, height: 56, borderRadius: 14, background: 'var(--surface)', border: '0.5px solid var(--border)', display: 'flex', alignItems: 'center', justifyContent: 'center', marginBottom: 16, color: 'var(--fg-muted)' }}>
          <Icon name="sparkle" size={26} stroke={1.5} />
        </div>
        <div style={{ fontSize: 20, fontWeight: 600, letterSpacing: '-0.02em', fontFamily: 'var(--font-display)', marginBottom: 6 }}>
          Compare yourself against multiple JDs at once
        </div>
        <div style={{ fontSize: 13, color: 'var(--fg-muted)', lineHeight: 1.55, maxWidth: 520 }}>
          Paste 2+ job descriptions, route the comparison through your ChatGPT, Claude, or Gemini, and see which roles fit you best — without paying for an API.
        </div>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
        <button onClick={onUploadResume} style={{
          background: 'var(--surface)', border: '0.5px solid var(--border)',
          borderRadius: 10, padding: 16, textAlign: 'left', cursor: 'pointer',
          fontFamily: 'inherit', color: 'var(--fg)', display: 'flex', flexDirection: 'column', gap: 8,
        }} className="kanban-card">
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <div style={{ width: 26, height: 26, borderRadius: 7, background: 'var(--surface-2)', border: '0.5px solid var(--border)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
              <Icon name="doc" size={14} />
            </div>
            <span style={{ fontSize: 10, color: 'var(--fg-muted)', textTransform: 'uppercase', letterSpacing: '0.06em', fontWeight: 600 }}>Step 1</span>
          </div>
          <div style={{ fontSize: 13.5, fontWeight: 600 }}>Upload your resume</div>
          <div style={{ fontSize: 11.5, color: 'var(--fg-muted)', lineHeight: 1.5 }}>
            PDF, DOCX, or paste plain text. We never share it — it just gets included in the prompt you copy.
          </div>
          <div style={{ marginTop: 'auto', paddingTop: 4, fontSize: 11.5, color: 'var(--fg)', fontWeight: 500, display: 'flex', alignItems: 'center', gap: 4 }}>
            Choose file <Icon name="arrowRight" size={11} />
          </div>
        </button>

        <div style={{ background: 'var(--surface-2)', border: '0.5px dashed var(--border)', borderRadius: 10, padding: 16, display: 'flex', flexDirection: 'column', gap: 8, opacity: 0.6 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <div style={{ width: 26, height: 26, borderRadius: 7, background: 'var(--surface)', border: '0.5px solid var(--border)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
              <Icon name="plus" size={14} stroke={2} />
            </div>
            <span style={{ fontSize: 10, color: 'var(--fg-muted)', textTransform: 'uppercase', letterSpacing: '0.06em', fontWeight: 600 }}>Step 2</span>
          </div>
          <div style={{ fontSize: 13.5, fontWeight: 600 }}>Add 2 or more JDs</div>
          <div style={{ fontSize: 11.5, color: 'var(--fg-muted)', lineHeight: 1.5 }}>
            Paste JDs from your saved applications, or paste fresh ones. We'll generate a single comparison prompt.
          </div>
        </div>
      </div>
    </div>
  </div>
);

export const EmptyJDBreakdownView = ({ onPasteJD }) => (
  <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '40px 28px', overflowY: 'auto' }}>
    <div style={{ maxWidth: 640, width: '100%' }}>
      <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', textAlign: 'center', marginBottom: 24 }}>
        <div style={{ width: 56, height: 56, borderRadius: 14, background: 'var(--surface)', border: '0.5px solid var(--border)', display: 'flex', alignItems: 'center', justifyContent: 'center', marginBottom: 16, color: 'var(--fg-muted)' }}>
          <Icon name="target" size={26} stroke={1.5} />
        </div>
        <div style={{ fontSize: 20, fontWeight: 600, letterSpacing: '-0.02em', fontFamily: 'var(--font-display)', marginBottom: 6 }}>
          Got a dream job? Pull it apart.
        </div>
        <div style={{ fontSize: 13, color: 'var(--fg-muted)', lineHeight: 1.55, maxWidth: 480 }}>
          We'll extract every must-have and nice-to-have, map them to your resume, propose tailored bullet points, and build a study plan for what's missing.
        </div>
      </div>

      <div style={{ background: 'var(--surface)', border: '0.5px solid var(--border)', borderRadius: 10, padding: 4 }}>
        <textarea
          placeholder="Paste a job description here…&#10;&#10;Title, requirements, responsibilities, comp range — paste everything from the listing."
          style={{
            width: '100%', minHeight: 140, padding: 12,
            background: 'transparent', border: 'none', outline: 'none',
            color: 'var(--fg)', fontSize: 12, lineHeight: 1.6,
            fontFamily: 'inherit', resize: 'vertical', boxSizing: 'border-box',
          }}
        />
        <div style={{ padding: '8px 10px', borderTop: '0.5px solid var(--border)', display: 'flex', alignItems: 'center', gap: 8 }}>
          <span style={{ fontSize: 11, color: 'var(--fg-muted)' }}>or</span>
          <button className="btn-secondary" style={{ fontSize: 11.5, padding: '4px 8px' }}>
            <Icon name="link" size={11} /> Paste URL
          </button>
          <button className="btn-secondary" style={{ fontSize: 11.5, padding: '4px 8px' }}>
            <Icon name="inbox" size={11} /> Pick from applications
          </button>
          <div style={{ flex: 1 }} />
          <button onClick={onPasteJD} className="btn-primary" style={{ fontSize: 12 }}>
            Parse this JD <Icon name="arrowRight" size={11} />
          </button>
        </div>
      </div>
    </div>
  </div>
);

