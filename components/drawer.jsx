// Detail drawer for a single application
const DetailDrawer = ({ appId, apps, companies, onClose, onUpdate }) => {
  const app = apps.find(a => a.id === appId);
  if (!app) return null;
  const company = companies.find(c => c.id === app.companyId);
  const portal = PORTAL_STATUS[company.id];
  const col = stageColors[app.stage];

  // Fake event history
  const events = [
    { date: 'Apr 19', type: 'auto', text: 'Status pulled from portal: no change' },
    app.stage !== 'saved' && app.stage !== 'applied' && { date: `Apr ${19 - Math.max(1, Math.floor(app.appliedDays / 2))}`, type: 'milestone', text: `Advanced to ${STAGES.find(s => s.id === app.stage).label}` },
    { date: `Apr ${19 - app.appliedDays}`, type: 'milestone', text: 'Application submitted' },
    app.referral && { date: `Apr ${19 - app.appliedDays - 2}`, type: 'note', text: 'Referral submitted' },
  ].filter(Boolean);

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
          <div style={{ fontSize: 11, color: 'var(--fg-muted)' }}>{company.sector} · {company.loc}</div>
        </div>
        <button onClick={onClose} style={{
          background: 'transparent', border: 'none', color: 'var(--fg-muted)',
          cursor: 'pointer', padding: 6, borderRadius: 5, display: 'flex',
        }} className="icon-btn">
          <Icon name="x" size={16} />
        </button>
      </div>

      <div style={{ padding: '18px 20px', flex: 1, overflowY: 'auto' }}>
        <div style={{ fontSize: 18, fontWeight: 600, color: 'var(--fg)', letterSpacing: '-0.01em', marginBottom: 4 }}>{app.role}</div>
        <div style={{ fontSize: 12, color: 'var(--fg-muted)', marginBottom: 14 }}>
          {app.team} · ID: <span style={{ fontFamily: 'var(--font-mono)' }}>{app.jobId}</span>
        </div>

        {/* stage selector */}
        <div style={{ marginBottom: 18 }}>
          <div style={{ fontSize: 11, fontWeight: 500, color: 'var(--fg-muted)', textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: 6 }}>Stage</div>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4 }}>
            {STAGES.map(s => (
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

        {/* Portal sync status */}
        <div style={{
          marginBottom: 18,
          background: portal && !portal.ok ? 'oklch(0.97 0.03 30)' : 'var(--surface-2)',
          border: `0.5px solid ${portal && !portal.ok ? 'oklch(0.88 0.06 30)' : 'var(--border)'}`,
          borderRadius: 8, padding: 12,
        }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6 }}>
            <PortalDot companyId={company.id} />
            <span style={{ fontSize: 12, fontWeight: 600, color: 'var(--fg)' }}>
              Portal auto-sync
            </span>
            <span style={{ marginLeft: 'auto', fontSize: 10.5, color: 'var(--fg-muted)', fontFamily: 'var(--font-mono)' }}>
              {portal?.lastSync || '—'}
            </span>
          </div>
          {portal && !portal.ok ? (
            <>
              <div style={{ fontSize: 11.5, color: 'oklch(0.45 0.15 30)', marginBottom: 8 }}>
                {portal.reason}. Your login expired — click to re-auth and pull the latest status.
              </div>
              <button className="btn-primary" style={{ fontSize: 11.5 }}>
                <Icon name="refresh" size={12} /> Re-authenticate
              </button>
            </>
          ) : portal ? (
            <div style={{ fontSize: 11.5, color: 'var(--fg-muted)' }}>
              Browser extension is logged in. Status will refresh automatically every 6 hours.
            </div>
          ) : (
            <div style={{ fontSize: 11.5, color: 'var(--fg-muted)' }}>
              Not yet connected. <a style={{ color: 'var(--accent)', textDecoration: 'none' }}>Link portal →</a>
            </div>
          )}
        </div>

        {/* Meta grid */}
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10, marginBottom: 18 }}>
          {[
            { label: 'Comp', value: app.salary },
            { label: 'Location', value: app.location },
            { label: 'Remote', value: app.remote },
            { label: 'Source', value: app.source },
            { label: 'Applied', value: app.appliedDays === 0 ? 'Draft' : `${app.appliedDays} days ago` },
            { label: 'Referral', value: app.referral ? 'Yes' : 'No' },
          ].map(({ label, value }) => (
            <div key={label}>
              <div style={{ fontSize: 10.5, color: 'var(--fg-muted)', textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: 2 }}>{label}</div>
              <div style={{ fontSize: 12.5, color: 'var(--fg)' }}>{value}</div>
            </div>
          ))}
        </div>

        {/* Next step */}
        {app.nextStep && app.nextStep !== '—' && (
          <div style={{
            background: col.bg, border: `0.5px solid ${col.ring}`, borderRadius: 8,
            padding: 12, marginBottom: 18,
          }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 11, fontWeight: 600, color: col.fg, textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: 4 }}>
              <Icon name="calendar" size={11} /> Next step
            </div>
            <div style={{ fontSize: 13, color: col.fg, fontWeight: 500 }}>{app.nextStep}</div>
          </div>
        )}

        {/* Notes */}
        <div style={{ marginBottom: 18 }}>
          <div style={{ fontSize: 11, fontWeight: 500, color: 'var(--fg-muted)', textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: 6 }}>Notes</div>
          <div style={{
            fontSize: 12.5, color: app.notes ? 'var(--fg)' : 'var(--fg-muted)',
            padding: 10, background: 'var(--surface-2)', borderRadius: 6,
            border: '0.5px solid var(--border)', minHeight: 36,
            fontStyle: app.notes ? 'normal' : 'italic',
            lineHeight: 1.5,
          }}>
            {app.notes || 'Add notes about this application…'}
          </div>
        </div>

        {/* Timeline */}
        <div>
          <div style={{ fontSize: 11, fontWeight: 500, color: 'var(--fg-muted)', textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: 8 }}>Activity</div>
          <div style={{ position: 'relative', paddingLeft: 14 }}>
            <div style={{ position: 'absolute', left: 4, top: 4, bottom: 4, width: 1, background: 'var(--border)' }} />
            {events.map((e, i) => (
              <div key={i} style={{ position: 'relative', marginBottom: 10 }}>
                <div style={{ position: 'absolute', left: -14, top: 4, width: 9, height: 9, borderRadius: 5, background: e.type === 'milestone' ? col.dot : 'var(--border-strong)', boxShadow: '0 0 0 3px var(--surface)' }} />
                <div style={{ fontSize: 10.5, color: 'var(--fg-muted)', fontFamily: 'var(--font-mono)' }}>{e.date}</div>
                <div style={{ fontSize: 12, color: 'var(--fg)' }}>{e.text}</div>
              </div>
            ))}
          </div>
        </div>
      </div>

      <div style={{ padding: 14, borderTop: '0.5px solid var(--border)', display: 'flex', gap: 6 }}>
        <button className="btn-primary" style={{ flex: 1 }}>
          <Icon name="external" size={13} /> Open in portal
        </button>
        <button className="btn-secondary">
          <Icon name="wand" size={13} /> Tailor resume
        </button>
        <button className="btn-secondary icon-only" title="More">
          <Icon name="dots" size={14} />
        </button>
      </div>
    </div>
  );
};
window.DetailDrawer = DetailDrawer;
