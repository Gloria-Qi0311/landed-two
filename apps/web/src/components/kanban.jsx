// Kanban view
import React from 'react';
import { CompanyMark, PortalDot, Icon, stageColors } from './primitives';
import { STAGES } from '../data';

export const KanbanView = ({ apps, companies, onOpen }) => {
  const pipelineStages = STAGES.filter(s => !['ghosted'].includes(s.id));
  const getCompany = (id) => companies.find(c => c.id === id);

  return (
    <div style={{ display: 'flex', gap: 12, padding: '8px 28px 24px', overflowX: 'auto', height: '100%', alignItems: 'stretch' }}>
      {pipelineStages.map(stage => {
        const items = apps.filter(a => a.stage === stage.id);
        const c = stageColors[stage.id];
        return (
          <div key={stage.id} style={{
            minWidth: 280, width: 280, flexShrink: 0,
            background: 'var(--surface-2)',
            borderRadius: 10,
            border: '0.5px solid var(--border)',
            display: 'flex', flexDirection: 'column',
            maxHeight: '100%',
          }}>
            <div style={{ padding: '10px 12px', display: 'flex', alignItems: 'center', gap: 8, borderBottom: '0.5px solid var(--border)' }}>
              <span style={{ width: 8, height: 8, borderRadius: 4, background: c.dot }} />
              <span style={{ fontSize: 12.5, fontWeight: 600, color: 'var(--fg)' }}>{stage.label}</span>
              <span style={{ marginLeft: 'auto', fontSize: 11, fontVariantNumeric: 'tabular-nums', color: 'var(--fg-muted)', background: 'var(--surface)', padding: '1px 7px', borderRadius: 8, border: '0.5px solid var(--border)' }}>{items.length}</span>
            </div>
            <div style={{ padding: 8, display: 'flex', flexDirection: 'column', gap: 6, overflowY: 'auto', flex: 1 }}>
              {items.map(a => {
                const comp = getCompany(a.companyId);
                return (
                  <div key={a.id} onClick={() => onOpen(a.id)} style={{
                    background: 'var(--surface)',
                    border: '0.5px solid var(--border)',
                    borderRadius: 8,
                    padding: 10,
                    cursor: 'pointer',
                    display: 'flex', flexDirection: 'column', gap: 8,
                    boxShadow: '0 1px 0 rgba(0,0,0,0.02)',
                  }} className="kanban-card">
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                      <CompanyMark company={comp} size={24} />
                      <div style={{ minWidth: 0, flex: 1 }}>
                        <div style={{ fontSize: 12, fontWeight: 600, color: 'var(--fg)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{comp.name}</div>
                        <div style={{ fontSize: 10.5, color: 'var(--fg-muted)' }}>{comp.loc}</div>
                      </div>
                      <PortalDot companyId={comp.id} />
                    </div>
                    <div style={{ fontSize: 12.5, color: 'var(--fg)', fontWeight: 500, lineHeight: 1.3 }}>{a.role}</div>
                    {a.nextStep && a.nextStep !== '—' && (
                      <div style={{ fontSize: 10.5, color: c.fg, display: 'flex', alignItems: 'center', gap: 4, background: c.bg, padding: '3px 6px', borderRadius: 5, marginTop: -2, width: 'fit-content' }}>
                        <Icon name={a.stage === 'offer' ? 'sparkle' : 'calendar'} size={10} />
                        {a.nextStep}
                      </div>
                    )}
                    <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 10.5, color: 'var(--fg-muted)' }}>
                      {a.referral && <span style={{ background: 'oklch(0.96 0.03 90)', color: 'oklch(0.42 0.1 90)', padding: '1px 5px', borderRadius: 4, fontSize: 10 }}>referral</span>}
                      <span style={{ fontVariantNumeric: 'tabular-nums' }}>{a.appliedDays === 0 ? 'draft' : `${a.appliedDays}d ago`}</span>
                      {a.starred && <Icon name="star" size={11} stroke={2} />}
                    </div>
                  </div>
                );
              })}
              {items.length === 0 && (
                <div style={{ fontSize: 11, color: 'var(--fg-muted)', textAlign: 'center', padding: 16, border: '1px dashed var(--border)', borderRadius: 6 }}>empty</div>
              )}
            </div>
          </div>
        );
      })}
    </div>
  );
};
