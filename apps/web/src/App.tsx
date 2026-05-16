import { useState, useEffect, useMemo } from 'react';
import { Routes, Route, Navigate, useSearchParams } from 'react-router-dom';

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

// Pre-Supabase placeholder. Real "no data" wiring (apps.length === 0,
// portal_connections.length === 0, etc.) lands with the data layer in #10.
// Until then, empty states are previewable via `?preview=empty` URL param —
// driven by the screenshot harness (apps/web/scripts/screens.js).
function usePreviewEmpty() {
  const [params] = useSearchParams();
  return params.get('preview') === 'empty';
}

export function App() {
  const [theme, setTheme] = useState<string>(
    () => localStorage.getItem('landed:theme') || 'cool'
  );
  const [apps, setApps] = useState<any[]>(APPLICATIONS);
  const [openApp, setOpenApp] = useState<string | null>(null);

  // Auth + onboarding state — persisted to localStorage so reloads remember
  const [signedIn, setSignedIn] = useState<boolean>(
    () => localStorage.getItem('landed:signedIn') === 'true'
  );
  const [profileOpen, setProfileOpen] = useState(false);
  const [showTour, setShowTour] = useState(false);

  // Theme: apply on <body> + persist
  useEffect(() => {
    document.body.setAttribute('data-theme', theme);
    localStorage.setItem('landed:theme', theme);
  }, [theme]);

  // `landed:onboarded_at` mirrors the eventual `users.onboarded_at TIMESTAMP` Supabase
  // column (spec.md §3). Stored as an ISO 8601 string so the migration to a real DB
  // is a JSON.stringify(new Date()) → DB write swap, nothing more.
  useEffect(() => {
    if (signedIn) {
      localStorage.setItem('landed:signedIn', 'true');
      if (!localStorage.getItem('landed:onboarded_at')) {
        setShowTour(true);
      }
    } else {
      localStorage.removeItem('landed:signedIn');
    }
  }, [signedIn]);

  const handleSignIn = () => setSignedIn(true);
  const handleSignOut = () => {
    setSignedIn(false);
    localStorage.removeItem('landed:onboarded_at');
    setProfileOpen(false);
  };
  const handleTourClose = () => {
    setShowTour(false);
    localStorage.setItem('landed:onboarded_at', new Date().toISOString());
  };
  const handleShowTour = () => {
    localStorage.removeItem('landed:onboarded_at');
    setShowTour(true);
    setProfileOpen(false);
  };

  const updateApp = (id: string, patch: any) => {
    setApps((prev) => prev.map((a) => (a.id === id ? { ...a, ...patch } : a)));
  };

  return (
    <div style={{ display: 'flex', height: '100vh', width: '100vw', background: 'var(--bg)' }}>
      {!signedIn && <LoginScreen onSignIn={handleSignIn} />}

      <Sidebar apps={apps} onProfileClick={() => setProfileOpen((o) => !o)} />

      <ProfileMenu
        open={profileOpen}
        onClose={() => setProfileOpen(false)}
        onSignOut={handleSignOut}
        onShowTour={handleShowTour}
        theme={theme}
        setTheme={setTheme}
      />

      {showTour && signedIn && <OnboardingTour onClose={handleTourClose} />}

      <main style={{ flex: 1, display: 'flex', flexDirection: 'column', minWidth: 0, height: '100%' }}>
        <Routes>
          <Route path="/" element={<Navigate to="/applications" replace />} />
          <Route path="/applications" element={<ApplicationsPage apps={apps} onOpenApp={setOpenApp} />} />
          <Route path="/sync" element={<SyncRoute />} />
          <Route path="/resume-match" element={<ResumeMatchRoute />} />
          <Route path="/jd-breakdown" element={<JDBreakdownRoute />} />
          <Route path="/resumes" element={<ResumesPlaceholder />} />
          <Route path="*" element={<Navigate to="/applications" replace />} />
        </Routes>
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
    </div>
  );
}

function ApplicationsPage({ apps, onOpenApp }: { apps: any[]; onOpenApp: (id: string) => void }) {
  const [searchParams, setSearchParams] = useSearchParams();
  const view = searchParams.get('view') || 'kanban';
  const filter = searchParams.get('filter') || 'all';
  const setView = (id: string) => {
    const next = new URLSearchParams(searchParams);
    if (id === 'kanban') next.delete('view');
    else next.set('view', id);
    setSearchParams(next, { replace: true });
  };
  const [query, setQuery] = useState('');

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
  const ViewComp = ViewCompMap[view] || KanbanView;

  if (usePreviewEmpty()) {
    return (
      <>
        <PageHeader
          title="Applications"
          subtitle="No applications yet — start by connecting a portal or adding manually"
        />
        <EmptyApplicationsView onAddManual={() => {}} onConnectPortal={() => {}} />
      </>
    );
  }

  return (
    <>
      <PageHeader
        title="Applications"
        subtitle={`${filteredApps.length} of ${apps.length} · across ${new Set(filteredApps.map((a) => a.companyId)).size} companies`}
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
              />
            </div>
            <button className="btn-secondary">
              <Icon name="filter" size={13} /> Filter
            </button>
            <button className="btn-secondary">
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
              }}
            >
              {views.map((v) => (
                <button
                  key={v.id}
                  onClick={() => setView(v.id)}
                  title={v.label}
                  style={{
                    padding: 5,
                    background: view === v.id ? 'var(--surface)' : 'transparent',
                    color: view === v.id ? 'var(--fg)' : 'var(--fg-muted)',
                    border: 'none',
                    borderRadius: 5,
                    cursor: 'pointer',
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
      <StatsBanner apps={apps} />
      <div style={{ flex: 1, overflow: 'hidden', position: 'relative' }}>
        <ViewComp apps={filteredApps} companies={COMPANIES} onOpen={onOpenApp} />
      </div>
    </>
  );
}

function SyncRoute() {
  return usePreviewEmpty() ? (
    <>
      <PageHeader title="Sync" subtitle="Install the browser extension to enable auto-sync" />
      <EmptySyncView onInstall={() => {}} />
    </>
  ) : (
    <SyncPage />
  );
}

function ResumeMatchRoute() {
  return usePreviewEmpty() ? (
    <>
      <PageHeader title="Resume Match" subtitle="Upload a resume and add JDs to compare your fit" />
      <EmptyResumeMatchView onUploadResume={() => {}} onAddJD={() => {}} />
    </>
  ) : (
    <ResumeMatchPage />
  );
}

function JDBreakdownRoute() {
  return usePreviewEmpty() ? (
    <>
      <PageHeader title="JD Breakdown" subtitle="Paste a job description to extract requirements" />
      <EmptyJDBreakdownView onPasteJD={() => {}} />
    </>
  ) : (
    <JDBreakdownPage />
  );
}

function ResumesPlaceholder() {
  return (
    <>
      <PageHeader title="Resumes" subtitle="Resume management lands in Sprint 2 (issue #20)" />
      <div style={{ padding: 28, color: 'var(--fg-muted)', fontSize: 13 }}>Coming soon.</div>
    </>
  );
}
