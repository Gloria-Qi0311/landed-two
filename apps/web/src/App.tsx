import { useState, useEffect, useMemo } from 'react';

import { Sidebar, PageHeader, StatsBanner } from './components/shell';
import { LoginScreen, OnboardingTour, ProfileMenu } from './components/auth';
import { Icon } from './components/primitives';
import { KanbanView } from './components/kanban';
import { TableView } from './components/table';
import { TimelineView, CardsView, MapView } from './components/other-views';
import { DetailDrawer } from './components/drawer';
import { SyncPage } from './components/sync-page';
import { ResumeMatchPage } from './components/resume-match';
import { JDBreakdownPage } from './components/jd-breakdown';
import {
  EmptyApplicationsView,
  EmptySyncView,
  EmptyResumeMatchView,
  EmptyJDBreakdownView,
} from './components/empty-states';
import { STAGES, COMPANIES, APPLICATIONS } from './data';

const TWEAKS = /*EDITMODE-BEGIN*/ {
  theme: 'cool',
  density: 'compact',
  defaultView: 'kanban',
  showStats: true,
  language: 'bilingual',
  emptyState: false,
} /*EDITMODE-END*/;

export function App() {
  const [tweaks, setTweaks] = useState<any>(TWEAKS);
  const [tweaksOpen, setTweaksOpen] = useState(false);
  const [currentPage, setCurrentPage] = useState<string>(
    () => localStorage.getItem('landed:page') || 'dashboard'
  );
  const [view, setView] = useState<string>(
    () => localStorage.getItem('landed:view') || tweaks.defaultView
  );
  const [filter, setFilter] = useState('all');
  const [query, setQuery] = useState('');
  const [openApp, setOpenApp] = useState<string | null>(null);
  const [apps, setApps] = useState<any[]>(APPLICATIONS);

  // Auth + onboarding state — persisted to localStorage so reloads remember
  const [signedIn, setSignedIn] = useState<boolean>(
    () => localStorage.getItem('landed:signedIn') === 'true'
  );
  const [profileOpen, setProfileOpen] = useState(false);
  const [showTour, setShowTour] = useState(false);

  useEffect(() => {
    if (signedIn) {
      localStorage.setItem('landed:signedIn', 'true');
      if (!localStorage.getItem('landed:onboarded')) {
        setShowTour(true);
      }
    } else {
      localStorage.removeItem('landed:signedIn');
    }
  }, [signedIn]);

  const handleSignIn = () => setSignedIn(true);
  const handleSignOut = () => {
    setSignedIn(false);
    localStorage.removeItem('landed:onboarded');
    setProfileOpen(false);
  };
  const handleTourClose = () => {
    setShowTour(false);
    localStorage.setItem('landed:onboarded', 'true');
  };
  const handleShowTour = () => {
    localStorage.removeItem('landed:onboarded');
    setShowTour(true);
    setProfileOpen(false);
  };

  useEffect(() => {
    localStorage.setItem('landed:view', view);
  }, [view]);
  useEffect(() => {
    localStorage.setItem('landed:page', currentPage);
  }, [currentPage]);
  useEffect(() => {
    document.body.setAttribute('data-theme', tweaks.theme);
    document.body.setAttribute('data-density', tweaks.density);
  }, [tweaks]);

  // Tweaks mode protocol (preserved — stripped in issue #4)
  useEffect(() => {
    const handler = (e: MessageEvent) => {
      if (e.data?.type === '__activate_edit_mode') setTweaksOpen(true);
      if (e.data?.type === '__deactivate_edit_mode') setTweaksOpen(false);
    };
    window.addEventListener('message', handler);
    window.parent.postMessage({ type: '__edit_mode_available' }, '*');
    return () => window.removeEventListener('message', handler);
  }, []);

  const updateTweak = (key: string, value: any) => {
    const next = { ...tweaks, [key]: value };
    setTweaks(next);
    window.parent.postMessage(
      { type: '__edit_mode_set_keys', edits: { [key]: value } },
      '*'
    );
  };

  const filteredApps = useMemo(() => {
    let list = apps;
    if (filter === 'active') list = list.filter((a) => !['rejected', 'ghosted'].includes(a.stage));
    else if (filter === 'starred') list = list.filter((a) => a.starred);
    else if (filter !== 'all' && STAGES.some((s: any) => s.id === filter))
      list = list.filter((a) => a.stage === filter);
    if (query) {
      const q = query.toLowerCase();
      list = list.filter((a) => {
        const c = COMPANIES.find((x: any) => x.id === a.companyId);
        return (
          (c?.name || '').toLowerCase().includes(q) ||
          a.role.toLowerCase().includes(q) ||
          (a.team || '').toLowerCase().includes(q)
        );
      });
    }
    return list;
  }, [apps, filter, query]);

  const updateApp = (id: string, patch: any) => {
    setApps((prev) => prev.map((a) => (a.id === id ? { ...a, ...patch } : a)));
  };

  const views = [
    { id: 'kanban', icon: 'kanban', label: 'Kanban' },
    { id: 'table', icon: 'table', label: 'Table' },
    { id: 'timeline', icon: 'timeline', label: 'Timeline' },
    { id: 'cards', icon: 'cards', label: 'Cards' },
    { id: 'map', icon: 'map', label: 'Map' },
  ];

  const ViewCompMap: Record<string, any> = {
    kanban: KanbanView,
    table: TableView,
    timeline: TimelineView,
    cards: CardsView,
    map: MapView,
  };
  const ViewComp = ViewCompMap[view];

  return (
    <div style={{ display: 'flex', height: '100vh', width: '100vw', background: 'var(--bg)' }}>
      {!signedIn && <LoginScreen onSignIn={handleSignIn} />}

      <Sidebar
        currentPage={currentPage}
        setCurrentPage={setCurrentPage}
        filter={filter}
        setFilter={setFilter}
        apps={apps}
        companies={COMPANIES}
        tweaks={tweaks}
        onProfileClick={() => setProfileOpen((o) => !o)}
      />

      <ProfileMenu
        open={profileOpen}
        onClose={() => setProfileOpen(false)}
        onSignOut={handleSignOut}
        onShowTour={handleShowTour}
      />

      {showTour && signedIn && <OnboardingTour onClose={handleTourClose} />}

      <main style={{ flex: 1, display: 'flex', flexDirection: 'column', minWidth: 0, height: '100%' }}>
        {currentPage === 'dashboard' && (
          <>
            <PageHeader
              title="Applications"
              subtitle={
                tweaks.emptyState
                  ? 'No applications yet — start by connecting a portal or adding manually'
                  : `${filteredApps.length} of ${apps.length} · across ${new Set(filteredApps.map((a) => a.companyId)).size} companies`
              }
              actions={
                <>
                  <div style={{ position: 'relative' }}>
                    <span style={{ position: 'absolute', left: 8, top: 6, color: 'var(--fg-muted)' }}>
                      <Icon name="search" size={13} />
                    </span>
                    <input
                      type="text"
                      placeholder="Search…"
                      value={query}
                      onChange={(e) => setQuery(e.target.value)}
                      style={{ paddingLeft: 28, width: 200 }}
                      disabled={tweaks.emptyState}
                    />
                  </div>
                  <button
                    className="btn-secondary"
                    disabled={tweaks.emptyState}
                    style={tweaks.emptyState ? { opacity: 0.4, cursor: 'not-allowed' } : {}}
                  >
                    <Icon name="filter" size={13} /> Filter
                  </button>
                  <button
                    className="btn-secondary"
                    disabled={tweaks.emptyState}
                    style={tweaks.emptyState ? { opacity: 0.4, cursor: 'not-allowed' } : {}}
                  >
                    <Icon name="sort" size={13} /> Sort
                  </button>
                  <div
                    style={{
                      display: 'flex',
                      gap: 2,
                      background: 'var(--surface-2)',
                      padding: 3,
                      borderRadius: 7,
                      border: '0.5px solid var(--border)',
                      opacity: tweaks.emptyState ? 0.4 : 1,
                    }}
                  >
                    {views.map((v) => (
                      <button
                        key={v.id}
                        onClick={() => !tweaks.emptyState && setView(v.id)}
                        title={v.label}
                        style={{
                          padding: 5,
                          background: view === v.id ? 'var(--surface)' : 'transparent',
                          color: view === v.id ? 'var(--fg)' : 'var(--fg-muted)',
                          border: 'none',
                          borderRadius: 5,
                          cursor: tweaks.emptyState ? 'not-allowed' : 'pointer',
                          display: 'flex',
                          alignItems: 'center',
                          boxShadow: view === v.id ? '0 1px 2px rgba(0,0,0,0.06)' : 'none',
                        }}
                      >
                        <Icon name={v.icon} size={14} />
                      </button>
                    ))}
                  </div>
                  <button className="btn-primary">
                    <Icon name="plus" size={13} stroke={2} /> Add
                  </button>
                </>
              }
            />

            {tweaks.emptyState ? (
              <EmptyApplicationsView
                onAddManual={() => {}}
                onConnectPortal={() => setCurrentPage('sync')}
              />
            ) : (
              <>
                {tweaks.showStats && <StatsBanner apps={apps} />}
                <div style={{ flex: 1, overflow: 'hidden', position: 'relative' }}>
                  <ViewComp apps={filteredApps} companies={COMPANIES} onOpen={setOpenApp} />
                </div>
              </>
            )}
          </>
        )}

        {currentPage === 'sync' &&
          (tweaks.emptyState ? (
            <div style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
              <PageHeader title="Sync" subtitle="Install the browser extension to enable auto-sync" />
              <EmptySyncView onInstall={() => {}} />
            </div>
          ) : (
            <SyncPage />
          ))}

        {currentPage === 'resume-match' &&
          (tweaks.emptyState ? (
            <div style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
              <PageHeader title="Resume Match" subtitle="Upload a resume and add JDs to compare your fit" />
              <EmptyResumeMatchView onUploadResume={() => {}} onAddJD={() => {}} />
            </div>
          ) : (
            <ResumeMatchPage />
          ))}

        {currentPage === 'jd-breakdown' &&
          (tweaks.emptyState ? (
            <div style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
              <PageHeader title="JD Breakdown" subtitle="Paste a job description to extract requirements" />
              <EmptyJDBreakdownView onPasteJD={() => {}} />
            </div>
          ) : (
            <JDBreakdownPage />
          ))}
      </main>

      {openApp && (
        <DetailDrawer
          appId={openApp}
          apps={apps}
          companies={COMPANIES}
          onClose={() => setOpenApp(null)}
          onUpdate={updateApp}
        />
      )}

      {tweaksOpen && (
        <TweaksPanel tweaks={tweaks} updateTweak={updateTweak} onClose={() => setTweaksOpen(false)} />
      )}
    </div>
  );
}

function TweaksPanel({ tweaks, updateTweak }: { tweaks: any; updateTweak: (k: string, v: any) => void; onClose: () => void }) {
  const Row = ({ label, children }: { label: string; children: any }) => (
    <div style={{ marginBottom: 12 }}>
      <div
        style={{
          fontSize: 10.5,
          fontWeight: 600,
          color: 'var(--fg-muted)',
          textTransform: 'uppercase',
          letterSpacing: '0.06em',
          marginBottom: 5,
        }}
      >
        {label}
      </div>
      {children}
    </div>
  );

  const Chips = ({ value, onChange, options }: { value: any; onChange: (v: any) => void; options: any[] }) => (
    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4 }}>
      {options.map((o) => (
        <button
          key={o.id}
          onClick={() => onChange(o.id)}
          style={{
            padding: '4px 9px',
            fontSize: 11.5,
            fontWeight: 500,
            background: value === o.id ? 'var(--fg)' : 'var(--surface)',
            color: value === o.id ? 'var(--bg)' : 'var(--fg)',
            border: `0.5px solid ${value === o.id ? 'var(--fg)' : 'var(--border)'}`,
            borderRadius: 5,
            cursor: 'pointer',
          }}
        >
          {o.label}
        </button>
      ))}
    </div>
  );

  return (
    <div
      style={{
        position: 'fixed',
        bottom: 16,
        right: 16,
        width: 280,
        background: 'var(--surface)',
        border: '0.5px solid var(--border)',
        borderRadius: 10,
        padding: 14,
        zIndex: 100,
        boxShadow: '0 20px 60px rgba(0,0,0,0.15), 0 0 0 0.5px var(--border)',
        animation: 'slideIn 180ms cubic-bezier(0.2, 0, 0, 1)',
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', marginBottom: 12 }}>
        <Icon name="adjust" size={14} />
        <span style={{ fontSize: 12, fontWeight: 600, color: 'var(--fg)', marginLeft: 6 }}>Tweaks</span>
        <span style={{ marginLeft: 'auto', fontSize: 10.5, color: 'var(--fg-muted)' }}>persisted</span>
      </div>

      <Row label="Theme">
        <Chips
          value={tweaks.theme}
          onChange={(v) => updateTweak('theme', v)}
          options={[
            { id: 'cool', label: 'Cool' },
            { id: 'warm', label: 'Warm' },
            { id: 'editorial', label: 'Editorial' },
            { id: 'dark', label: 'Dark' },
          ]}
        />
      </Row>

      <Row label="Density">
        <Chips
          value={tweaks.density}
          onChange={(v) => updateTweak('density', v)}
          options={[
            { id: 'compact', label: 'Compact' },
            { id: 'regular', label: 'Regular' },
            { id: 'cozy', label: 'Cozy' },
          ]}
        />
      </Row>

      <Row label="Default view">
        <Chips
          value={tweaks.defaultView}
          onChange={(v) => updateTweak('defaultView', v)}
          options={[
            { id: 'kanban', label: 'Kanban' },
            { id: 'table', label: 'Table' },
            { id: 'timeline', label: 'Timeline' },
            { id: 'cards', label: 'Cards' },
            { id: 'map', label: 'Map' },
          ]}
        />
      </Row>

      <Row label="Top stats banner">
        <Chips
          value={tweaks.showStats ? 'on' : 'off'}
          onChange={(v) => updateTweak('showStats', v === 'on')}
          options={[
            { id: 'on', label: 'Show' },
            { id: 'off', label: 'Hide' },
          ]}
        />
      </Row>

      <Row label="Preview as new user">
        <Chips
          value={tweaks.emptyState ? 'on' : 'off'}
          onChange={(v) => updateTweak('emptyState', v === 'on')}
          options={[
            { id: 'off', label: 'With data' },
            { id: 'on', label: 'Empty states' },
          ]}
        />
      </Row>
    </div>
  );
}
