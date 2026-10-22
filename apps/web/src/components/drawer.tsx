// Detail drawer for a single application
import React, { useEffect, useState, type CSSProperties } from 'react';
import type { ApplicationPatch } from '../lib/store';
import type { BoardApp, BoardCompany } from '../hooks/queries';
import { CompanyMark, Icon, stageColors } from './primitives';
import { STAGES, columnOf } from '../data';
import { PortalCard } from './portal-card';
import { ApplicationAssist } from './apply-assist';
import { InterviewRounds } from './interview-rounds';
import { EditableText } from './editable';
import { DeadlineChip } from './deadline-chip';
import { OpenAnswers } from './open-answers';

const label: CSSProperties = { fontSize: 10.5, color: 'var(--fg-muted)', textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: 2 };
const REMOTES = ['Remote', 'Hybrid', 'On-site'];

type DrawerProps = {
  appId: string;
  apps: BoardApp[];
  companies: BoardCompany[];
  onClose: () => void;
  onUpdate: (id: string, patch: ApplicationPatch) => void;
  onDelete?: (id: string) => Promise<void>;
  onOpenPosting?: (app: BoardApp, company: BoardCompany) => void;
};

export const DetailDrawer = ({ appId, apps, companies, onClose, onUpdate, onDelete, onOpenPosting }: DrawerProps) => {
  // Delete asks once, in place: the bar under the header.
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  useEffect(() => { setConfirmDelete(false); setDeleteError(null); }, [appId]);
  // Esc to close. Listener lives on document so it works even if focus is
  // outside the drawer (e.g. user just dragged a card from below and the
  // pointer is still over the main view).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

  const app = apps.find(a => a.id === appId);
  const company = app && companies.find(c => c.id === app.companyId);
  if (!app || !company) return null;
  const col = stageColors[app.stage];


  return (
    <div style={{
      position: 'fixed', top: 0, right: 0, bottom: 0, width: 460,
      background: 'var(--surface)', borderLeft: '0.5px solid var(--border)',
      boxShadow: '-12px 0 40px rgba(0,0,0,0.08)',
      display: 'flex', flexDirection: 'column', zIndex: 50,
      animation: 'slideIn 180ms cubic-bezier(0.2, 0, 0, 1)',
    }}>
      <div style={{ padding: '14px 20px', borderBottom: '0.5px solid var(--border)', display: 'flex', alignItems: 'center', gap: 10 }}>
        <CompanyMark company={company} size={36} />
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--fg)' }}>{company.name}</div>
          {(company.sector || company.loc) && (
            <div style={{ fontSize: 11, color: 'var(--fg-muted)' }}>{[company.sector, company.loc].filter(Boolean).join(' · ')}</div>
          )}
        </div>
        {onDelete && (
          <button onClick={() => setConfirmDelete(true)} title="Delete application" aria-label="Delete application" style={{
            background: 'transparent', border: 'none', color: 'var(--fg-muted)',
            cursor: 'pointer', padding: 6, borderRadius: 5, display: 'flex',
          }} className="icon-btn">
            <Icon name="trash" size={15} />
          </button>
        )}
        <button onClick={onClose} style={{
          background: 'transparent', border: 'none', color: 'var(--fg-muted)',
          cursor: 'pointer', padding: 6, borderRadius: 5, display: 'flex',
        }} className="icon-btn">
          <Icon name="x" size={16} />
        </button>
      </div>
      {confirmDelete && (
        <div role="alertdialog" aria-label="Delete application" style={{
          padding: '10px 20px', borderBottom: '0.5px solid var(--border)', background: 'oklch(0.97 0.02 30)',
          display: 'flex', alignItems: 'center', gap: 8, fontSize: 12, lineHeight: 1.45,
        }}>
          <span style={{ flex: 1, color: 'oklch(0.42 0.12 30)' }}>
            {deleteError ?? <>Delete <b>{company.name} — {app.role}</b>? Its rounds, notes and history go with it. This can't be undone.</>}
          </span>
          <button className="btn-secondary" disabled={deleting} onClick={() => setConfirmDelete(false)}>Cancel</button>
          <button className="btn-primary" disabled={deleting}
            style={{ background: 'oklch(0.5 0.16 30)', borderColor: 'oklch(0.5 0.16 30)' }}
            onClick={async () => {
              setDeleting(true);
              setDeleteError(null);
              try {
                await onDelete?.(app.id);
              } catch (e) {
                setDeleteError(`Couldn't delete it: ${(e as Error).message}`);
              } finally {
                setDeleting(false);
              }
            }}>
            {deleting ? 'Deleting…' : 'Delete'}
          </button>
        </div>
      )}

      <div style={{ padding: '18px 20px', flex: 1, overflowY: 'auto' }}>
        <div style={{ fontSize: 18, fontWeight: 600, color: 'var(--fg)', letterSpacing: '-0.01em', marginBottom: 4 }}>
          <EditableText label="role" value={app.role} placeholder="Role"
            onSave={(role) => role && onUpdate(app.id, { role })} />
        </div>
        <div style={{ fontSize: 12, color: 'var(--fg-muted)', marginBottom: 14 }}>
          <EditableText label="team" value={app.team} placeholder="Add team" onSave={(team) => onUpdate(app.id, { team: team || null })} />
          {app.jobId && <> · ID: <span style={{ fontFamily: 'var(--font-mono)' }}>{app.jobId}</span></>}
        </div>

        {/* stage selector */}
        <div style={{ marginBottom: 18 }}>
          <div style={{ fontSize: 11, fontWeight: 500, color: 'var(--fg-muted)', textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: 6 }}>Stage</div>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4 }}>
            {[{ id: 'saved', label: 'Lead' }, ...STAGES, { id: 'ghosted', label: 'Ghosted' }].map(s => (
              <button key={s.id} onClick={() => onUpdate(app.id, { stage: s.id })}
                style={{
                  padding: '4px 9px', borderRadius: 999,
                  fontSize: 11, fontWeight: 500,
                  background: s.id === app.stage ? stageColors[s.id].bg : 'transparent',
                  color: s.id === app.stage ? stageColors[s.id].fg : 'var(--fg-muted)',
                  border: `0.5px solid ${s.id === app.stage ? stageColors[s.id].ring : 'var(--border)'}`,
                  cursor: 'pointer',
                  display: 'inline-flex', alignItems: 'center', gap: 5,
                }}>
                <span style={{ width: 6, height: 6, borderRadius: 3, background: stageColors[s.id].dot }} />
                {s.label}
              </button>
            ))}
          </div>
        </div>

        {/* Interview rounds — Interview stage (or any rounds already logged) */}
        {(columnOf(app.stage) === 'interview' || app.interviews?.length > 0) && (
          <div style={{ marginBottom: 18 }}>
            <div style={{ fontSize: 11, fontWeight: 500, color: 'var(--fg-muted)', textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: 6 }}>
              Interviews{app.interviews?.length ? ` · ${app.interviews.length}` : ''}
            </div>
            <InterviewRounds rounds={app.interviews ?? []} onChange={(interviews) => onUpdate(app.id, { interviews })} />
          </div>
        )}

        {/* Not applied yet: open the posting and autofill it. Applied: the
            candidate portal, where your agent looks up the status (read-only). */}
        <ApplicationAssist app={app} companyName={company.name} />
        {app.stage !== 'saved' && (
          <div style={{ marginBottom: 18 }}>
            <PortalCard app={app} companyName={company.name} />
          </div>
        )}

        {/* Details — click any value to edit */}
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10, marginBottom: 18 }}>
          <div>
            <div style={label}>Comp</div>
            <div style={{ fontSize: 12.5 }}><EditableText label="compensation" value={app.salary === '—' ? '' : app.salary} placeholder="Add" onSave={(salary) => onUpdate(app.id, { salary: salary || null })} /></div>
          </div>
          <div>
            <div style={label}>Location</div>
            <div style={{ fontSize: 12.5 }}><EditableText label="location" value={app.location} placeholder="Add" onSave={(location) => onUpdate(app.id, { location: location || null })} /></div>
          </div>
          <div>
            <div style={label}>Remote</div>
            <select aria-label="Remote" value={app.remote || ''} onChange={(e) => onUpdate(app.id, { remote: e.target.value })}
              style={{ fontSize: 12.5, fontFamily: 'inherit', padding: '1px 4px', border: '0.5px solid var(--border)', borderRadius: 5, background: 'var(--surface)', color: 'var(--fg)' }}>
              {!app.remote && <option value="" disabled>Not set</option>}
              {REMOTES.map((r) => <option key={r} value={r}>{r}</option>)}
            </select>
          </div>
          <div>
            <div style={label}>Source</div>
            <div style={{ fontSize: 12.5 }}><EditableText label="source" value={app.source} placeholder="Add" onSave={(source) => onUpdate(app.id, { source: source || null })} /></div>
          </div>
          <div>
            <div style={label}>Apply by</div>
            <DeadlineChip deadline={app.deadline} onSave={(deadline) => onUpdate(app.id, { deadline })} />
          </div>
          <div>
            <div style={label}>Applied</div>
            <div style={{ fontSize: 12.5 }}>{app.stage === 'saved' ? 'Not yet' : app.appliedDays === 0 ? 'Today' : `${app.appliedDays} days ago`}</div>
          </div>
          <div>
            <div style={label}>Referral</div>
            <label style={{ fontSize: 12.5, display: 'flex', alignItems: 'center', gap: 6, cursor: 'pointer' }}>
              <input type="checkbox" checked={!!app.referral} onChange={(e) => onUpdate(app.id, { referral: e.target.checked })} />
              {app.referral ? 'Yes' : 'No'}
            </label>
          </div>
          <div style={{ gridColumn: '1 / -1' }}>
            <div style={label}>Job link</div>
            <div style={{ fontSize: 12.5, wordBreak: 'break-all', display: 'flex', alignItems: 'flex-start', gap: 6 }}>
              <span style={{ flex: 1, minWidth: 0 }}>
                <EditableText label="job link" value={app.portal_application_url} placeholder="Paste the posting or portal link"
                  onSave={(url) => onUpdate(app.id, { portal_application_url: url || null })} />
              </span>
              {app.portal_application_url && (
                <a href={app.portal_application_url} target="_blank" rel="noopener noreferrer" title="Open the posting" aria-label="Open the posting"
                  className="icon-btn" onClick={() => onOpenPosting?.(app, company)}
                  style={{ color: 'var(--fg-muted)', padding: 3, borderRadius: 4, display: 'flex', flexShrink: 0 }}>
                  <Icon name="external" size={13} />
                </a>
              )}
            </div>
          </div>
        </div>

        {/* Which resume Landed filled it from, and why */}
        {app.resume_choice && (
          <div style={{ fontSize: 11.5, color: 'var(--fg-muted)', lineHeight: 1.5, marginBottom: 10, display: 'flex', gap: 6 }}>
            <Icon name="doc" size={11} />
            <span><span style={{ color: 'var(--fg)' }}>Resume: {app.resume_choice.name}</span>{app.resume_choice.reason ? ` · ${app.resume_choice.reason}` : ''}</span>
          </div>
        )}
                {/* Next step */}
        <div style={{
          background: app.nextStep && app.nextStep !== '—' ? col.bg : 'var(--surface-2)',
          border: `0.5px solid ${app.nextStep && app.nextStep !== '—' ? col.ring : 'var(--border)'}`, borderRadius: 8,
          padding: 12, marginBottom: 18,
        }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 11, fontWeight: 600, color: col.fg, textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: 4 }}>
            <Icon name="calendar" size={11} /> Next step
          </div>
          <div style={{ fontSize: 13, color: col.fg, fontWeight: 500 }}>
            <EditableText label="next step" value={app.nextStep === '—' ? '' : app.nextStep} placeholder="e.g. Final round · Apr 23"
              onSave={(next_step) => onUpdate(app.id, { next_step: next_step || null })} />
          </div>
        </div>

        {/* The open-ended answers it was sent with ("Why us?") */}
        <OpenAnswers answers={app.open_answers} onSave={(open_answers) => onUpdate(app.id, { open_answers })} />

        {/* Notes */}
        <div style={{ marginBottom: 18 }}>
          <div style={{ fontSize: 11, fontWeight: 500, color: 'var(--fg-muted)', textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: 6 }}>Notes</div>
          <div style={{ fontSize: 12.5, padding: 10, background: 'var(--surface-2)', borderRadius: 6, border: '0.5px solid var(--border)', minHeight: 36, lineHeight: 1.5 }}>
            <EditableText label="notes" multiline value={app.notes} placeholder="Add notes about this application…  (⌘/Ctrl+Enter to save)"
              onSave={(notes) => onUpdate(app.id, { notes: notes || null })} />
          </div>
        </div>
      </div>
    </div>
  );
};
