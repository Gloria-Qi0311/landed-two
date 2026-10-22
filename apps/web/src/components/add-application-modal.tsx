// Add-application stub modal. Triggered by the + Add button on /applications.
// Per spec.md §9, this is "standard CRUD, not differentiating" — kept minimal
// (company + role required, everything else optional) so the screen exists
// before #20 (Resumes), #10 (data layer) etc. flesh it out.
//
// Pre-Supabase: onSubmit prepends to App's local apps array via the addApp
// callback. id is `local-<timestamp>-<rand>` so it can't collide with seeded
// 'a001'..'a044' ids. appliedDays/lastActivity default to 0 ("draft" rendering).
import React, { useEffect, useState, type CSSProperties, type FormEvent } from 'react';
import { Icon } from './primitives';
import { STAGES, COMPANIES } from '../data';

const FIELD: { label: CSSProperties; input: CSSProperties } = {
  label: { fontSize: 11, fontWeight: 500, color: 'var(--fg-muted)', textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: 4, display: 'block' },
  input: {
    width: '100%', padding: '6px 10px', fontSize: 12.5,
    background: 'var(--surface)', color: 'var(--fg)',
    border: '0.5px solid var(--border)', borderRadius: 6,
    outline: 'none', fontFamily: 'inherit', boxSizing: 'border-box',
  },
};

export type NewApplication = {
  companyName: string; role: string; team: string; stage: string; salary: string; location: string; source: string; notes: string;
};

export function AddApplicationModal({ open, onClose, onAdd, onImport }: { open: boolean; onClose: () => void; onAdd: (input: NewApplication) => Promise<unknown>; onImport?: () => void }) {
  const [companyId, setCompanyId] = useState('');
  const [role, setRole] = useState('');
  const [team, setTeam] = useState('');
  const [stage, setStage] = useState('applied');
  const [location, setLocation] = useState('');
  const [salary, setSalary] = useState('');
  const [source, setSource] = useState('');
  const [notes, setNotes] = useState('');

  // Esc to close; focus first input on open. Listener bound only while open.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('keydown', onKey);
    // Reset form each time the modal opens fresh
    setCompanyId('');
    setRole('');
    setTeam('');
    setStage('applied');
    setLocation('');
    setSalary('');
    setSource('');
    setNotes('');
    return () => document.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  if (!open) return null;

  const canSubmit = companyId && role.trim();

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    if (!canSubmit) return;
    const company = COMPANIES.find(c => c.id === companyId);
    try {
      await onAdd({
        companyName: company?.name || '',
        role: role.trim(),
        team: team.trim(),
        stage,
        salary: salary.trim(),
        location: location.trim() || company?.loc || '',
        source: source.trim(),
        notes: notes.trim(),
      });
      onClose();
    } catch (err) {
      // onAdd throws if the DB write fails; surface to console for now
      // (modal stays open so user can retry without retyping).
      console.error('add application failed:', err);
      alert(`Could not save: ${(err as Error)?.message || err}`);
    }
  };

  return (
    <div
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
      style={{
        position: 'fixed', inset: 0, zIndex: 250,
        background: 'oklch(0.18 0.01 240 / 0.45)',
        backdropFilter: 'blur(2px)',
        display: 'flex', alignItems: 'flex-start', justifyContent: 'center',
        paddingTop: '8vh',
        animation: 'slideIn 160ms ease',
      }}
    >
      <form
        onSubmit={handleSubmit}
        style={{
          width: 480, background: 'var(--surface)',
          border: '0.5px solid var(--border)', borderRadius: 12,
          boxShadow: '0 24px 64px rgba(0,0,0,0.22)',
          display: 'flex', flexDirection: 'column',
          maxHeight: '84vh',
        }}
      >
        <div style={{ padding: '14px 18px', borderBottom: '0.5px solid var(--border)', display: 'flex', alignItems: 'center', gap: 10 }}>
          <Icon name="plus" size={15} stroke={2} />
          <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--fg)' }}>Add application</div>
          <button
            type="button"
            onClick={onClose}
            style={{ marginLeft: 'auto', background: 'transparent', border: 'none', color: 'var(--fg-muted)', cursor: 'pointer', padding: 6, borderRadius: 5, display: 'flex' }}
            className="icon-btn"
          >
            <Icon name="x" size={15} />
          </button>
        </div>

        <div style={{ padding: '14px 18px', overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: 12 }}>
          {/* Many at once: the applications already tracked in a spreadsheet. */}
          {onImport && (
            <div style={{ display: 'flex', alignItems: 'center', gap: 10, paddingBottom: 12, borderBottom: '0.5px solid var(--border)' }}>
              <div style={{ flex: 1, fontSize: 12, color: 'var(--fg-muted)', lineHeight: 1.4 }}>
                Already tracking applications in a spreadsheet? Add them all at once: a CSV, or cells pasted from Excel or Google Sheets.
              </div>
              <button type="button" className="btn-secondary" onClick={onImport} style={{ fontSize: 12, flexShrink: 0 }}>
                <Icon name="upload" size={12} /> Import a spreadsheet
              </button>
            </div>
          )}
          <div>
            <label htmlFor="aam-company" style={FIELD.label}>Company *</label>
            <select
              id="aam-company"
              autoFocus
              value={companyId}
              onChange={(e) => setCompanyId(e.target.value)}
              style={FIELD.input}
            >
              <option value="">Select a company…</option>
              {COMPANIES.map(c => (
                <option key={c.id} value={c.id}>{c.name} · {c.sector}</option>
              ))}
            </select>
          </div>

          <div>
            <label htmlFor="aam-role" style={FIELD.label}>Role *</label>
            <input
              id="aam-role"
              type="text"
              value={role}
              onChange={(e) => setRole(e.target.value)}
              placeholder="e.g. Senior Frontend Engineer"
              style={FIELD.input}
            />
          </div>

          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
            <div>
              <label htmlFor="aam-team" style={FIELD.label}>Team</label>
              <input
                id="aam-team"
                type="text"
                value={team}
                onChange={(e) => setTeam(e.target.value)}
                placeholder="Optional"
                style={FIELD.input}
              />
            </div>
            <div>
              <label htmlFor="aam-stage" style={FIELD.label}>Stage</label>
              <select id="aam-stage" value={stage} onChange={(e) => setStage(e.target.value)} style={FIELD.input}>
                {STAGES.filter(s => s.id !== 'rejected').map(s => <option key={s.id} value={s.id}>{s.label}</option>)}
                <option value="saved">Lead — not applied yet</option>
              </select>
            </div>
          </div>

          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
            <div>
              <label htmlFor="aam-location" style={FIELD.label}>Location</label>
              <input id="aam-location" type="text" value={location} onChange={(e) => setLocation(e.target.value)} placeholder="Auto from company" style={FIELD.input} />
            </div>
            <div>
              <label htmlFor="aam-salary" style={FIELD.label}>Salary</label>
              <input id="aam-salary" type="text" value={salary} onChange={(e) => setSalary(e.target.value)} placeholder="$ or —" style={FIELD.input} />
            </div>
          </div>

          <div>
            <label htmlFor="aam-source" style={FIELD.label}>Source</label>
            <input
              id="aam-source"
              type="text"
              value={source}
              onChange={(e) => setSource(e.target.value)}
              placeholder="LinkedIn / Referral / Company site / …"
              style={FIELD.input}
            />
          </div>

          <div>
            <label htmlFor="aam-notes" style={FIELD.label}>Notes</label>
            <textarea
              id="aam-notes"
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              placeholder="What's the angle on this one?"
              rows={3}
              style={{ ...FIELD.input, resize: 'vertical', minHeight: 60, lineHeight: 1.5 }}
            />
          </div>
        </div>

        <div style={{ padding: 14, borderTop: '0.5px solid var(--border)', display: 'flex', gap: 6, justifyContent: 'flex-end' }}>
          <button type="button" onClick={onClose} className="btn-secondary">Cancel</button>
          <button
            type="submit"
            className="btn-primary"
            disabled={!canSubmit}
            style={!canSubmit ? { opacity: 0.4, cursor: 'not-allowed' } : {}}
          >
            Save
          </button>
        </div>
      </form>
    </div>
  );
}
