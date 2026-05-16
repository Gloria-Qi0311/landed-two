// Table view — dense, Airtable/Linear-ish
const TableView = ({ apps, companies, onOpen }) => {
  const getCompany = (id) => companies.find(c => c.id === id);
  const [sortKey, setSortKey] = useState('lastActivity');
  const [sortDir, setSortDir] = useState('asc');

  const sorted = useMemo(() => {
    const copy = [...apps];
    copy.sort((a, b) => {
      let va = a[sortKey], vb = b[sortKey];
      if (sortKey === 'company') { va = getCompany(a.companyId).name; vb = getCompany(b.companyId).name; }
      if (typeof va === 'string') return sortDir === 'asc' ? va.localeCompare(vb) : vb.localeCompare(va);
      return sortDir === 'asc' ? va - vb : vb - va;
    });
    return copy;
  }, [apps, sortKey, sortDir]);

  const Col = ({ k, label, width, align = 'left' }) => (
    <div onClick={() => {
      if (sortKey === k) setSortDir(d => d === 'asc' ? 'desc' : 'asc');
      else { setSortKey(k); setSortDir('asc'); }
    }} style={{
      width, flexShrink: 0, padding: '8px 10px', fontSize: 11,
      fontWeight: 500, color: 'var(--fg-muted)', textTransform: 'uppercase', letterSpacing: '0.05em',
      cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 4,
      justifyContent: align === 'right' ? 'flex-end' : 'flex-start',
      userSelect: 'none',
    }}>
      {label}
      {sortKey === k && <Icon name="chevronDown" size={10} stroke={2} />}
    </div>
  );

  return (
    <div style={{ padding: '8px 28px 24px', height: '100%', display: 'flex', flexDirection: 'column' }}>
      <div style={{
        background: 'var(--surface)',
        border: '0.5px solid var(--border)',
        borderRadius: 10,
        flex: 1,
        overflow: 'hidden',
        display: 'flex', flexDirection: 'column',
      }}>
        <div style={{ display: 'flex', borderBottom: '0.5px solid var(--border)', background: 'var(--surface-2)', position: 'sticky', top: 0, zIndex: 2 }}>
          <Col k="company" label="Company" width={200} />
          <Col k="role" label="Role" width={260} />
          <Col k="stage" label="Stage" width={130} />
          <Col k="nextStep" label="Next" width={180} />
          <Col k="location" label="Location" width={140} />
          <Col k="salary" label="Comp" width={130} />
          <Col k="source" label="Source" width={100} />
          <Col k="appliedDays" label="Applied" width={70} align="right" />
          <Col k="lastActivity" label="Last activity" width={100} align="right" />
          <div style={{ width: 40 }} />
        </div>
        <div style={{ overflowY: 'auto', flex: 1 }}>
          {sorted.map((a, i) => {
            const c = getCompany(a.companyId);
            return (
              <div key={a.id} onClick={() => onOpen(a.id)} className="table-row" style={{
                display: 'flex', alignItems: 'center',
                borderBottom: '0.5px solid var(--border-subtle)',
                fontSize: 12.5,
                cursor: 'pointer',
              }}>
                <div style={{ width: 200, padding: '8px 10px', display: 'flex', alignItems: 'center', gap: 8, flexShrink: 0 }}>
                  <CompanyMark company={c} size={22} />
                  <span style={{ fontWeight: 500, color: 'var(--fg)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{c.name}</span>
                  <PortalDot companyId={c.id} />
                </div>
                <div style={{ width: 260, padding: '8px 10px', color: 'var(--fg)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', flexShrink: 0 }}>
                  {a.role}
                  {a.starred && <Icon name="star" size={10} stroke={2} />}
                </div>
                <div style={{ width: 130, padding: '8px 10px', flexShrink: 0 }}><StageBadge stage={a.stage} /></div>
                <div style={{ width: 180, padding: '8px 10px', color: 'var(--fg-muted)', fontSize: 11.5, flexShrink: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{a.nextStep}</div>
                <div style={{ width: 140, padding: '8px 10px', color: 'var(--fg-muted)', flexShrink: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{a.location}</div>
                <div style={{ width: 130, padding: '8px 10px', color: 'var(--fg-muted)', fontSize: 11.5, fontVariantNumeric: 'tabular-nums', flexShrink: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{a.salary}</div>
                <div style={{ width: 100, padding: '8px 10px', color: 'var(--fg-muted)', fontSize: 11.5, flexShrink: 0 }}>{a.source}</div>
                <div style={{ width: 70, padding: '8px 10px', color: 'var(--fg-muted)', fontSize: 11.5, textAlign: 'right', fontVariantNumeric: 'tabular-nums', flexShrink: 0 }}>{a.appliedDays === 0 ? '—' : `${a.appliedDays}d`}</div>
                <div style={{ width: 100, padding: '8px 10px', color: 'var(--fg-muted)', fontSize: 11.5, textAlign: 'right', fontVariantNumeric: 'tabular-nums', flexShrink: 0 }}>{a.lastActivity === 0 ? '—' : `${a.lastActivity}d ago`}</div>
                <div style={{ width: 40, padding: '8px 10px', color: 'var(--fg-muted)', flexShrink: 0 }}><Icon name="chevronRight" size={13} /></div>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
};
window.TableView = TableView;
