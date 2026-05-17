import { useState, useEffect, useMemo, useRef } from 'react';
import { Routes, Route, Navigate, useSearchParams, useNavigate } from 'react-router-dom';
import { useQueryClient } from '@tanstack/react-query';
import { useOnboardedAt, useMarkOnboarded, useResetOnboarded } from './hooks/profile';
import type { Session } from '@supabase/supabase-js';

import { supabase } from './lib/supabase';
import {
  useApplications,
  useCompanies,
  useUpdateApplication,
  useAddApplication,
  useImportDemoData,
} from './hooks/queries';
import { Sidebar, PageHeader, StatsBanner } from './components/shell';
import { LoginScreen, OnboardingTour, ProfileMenu } from './components/auth';
import { Icon } from './components/primitives';
import { KanbanView } from './components/kanban';
import { TableView } from './components/table';
import { TimelineView, CardsView, MapView } from './components/other-views';
import { DetailDrawer } from './components/drawer';
import { AddApplicationModal } from './components/add-application-modal';
import { ResumesPage } from './components/resumes-page';
import { SyncPage } from './components/sync-page';
import { ResumeMatchPage } from './components/resume-match-page';
import { JDBreakdownPage } from './components/jd-breakdown-page';
import {
  EmptyApplicationsView,
  EmptySyncView,
  EmptyResumeMatchView,
  EmptyJDBreakdownView,
} from './components/empty-states';
import { STAGES, COMPANIES as COMPANY_CATALOG } from './data';

// Preview empty states via `?preview=empty` URL param — used by the
// screenshot harness. Real empty states render when the data layer returns
// no rows (apps.length === 0).
function usePreviewEmpty() {
  const [params] = useSearchParams();
  return params.get('preview') === 'empty';
}

export function App() {
  const [theme, setTheme] = useState<string>(
    () => localStorage.getItem('landed:theme') || 'cool'
  );
  const [openApp, setOpenApp] = useState<string | null>(null);
  const [addModalOpen, setAddModalOpen] = useState(false);

  // Auth state — Supabase manages session persistence under sb-<ref>-auth-token
  // in localStorage; we mirror the session object here and gate render on it.
  const [session, setSession] = useState<Session | null>(null);
  const [authReady, setAuthReady] = useState(false);
  const signedIn = !!session;
  const [profileOpen, setProfileOpen] = useState(false);
  const [showTour, setShowTour] = useState(false);

  // Data layer (TanStack Query → Supabase). enabled=signedIn so we don't
  // fire RLS-rejected requests while the LoginScreen is showing.
  const appsQuery = useApplications();
  const companiesQuery = useCompanies();
  const updateApp = useUpdateApplication();
  const addApp = useAddApplication();
  const importDemo = useImportDemoData();

  const apps = appsQuery.data ?? [];
  // Companies for rendering: prefer the user's table; fall back to the
  // catalog so newly-added apps don't visually break before the next refetch.
  const companies = (companiesQuery.data && companiesQuery.data.length > 0)
    ? companiesQuery.data
    : COMPANY_CATALOG;

  // Theme: apply on <body> + persist
  useEffect(() => {
    document.body.setAttribute('data-theme', theme);
    localStorage.setItem('landed:theme', theme);
  }, [theme]);

  // Hydrate session on mount + subscribe to subsequent changes (sign-in /
  // sign-out / token refresh / OAuth redirect-return). On SIGNED_IN /
  // SIGNED_OUT we also clear the TanStack Query cache so user A's data
  // never leaks into user B's session — RLS scopes the DB query, but the
  // client-side cache survives sign-out otherwise.
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  // Tracks the previous signed-in state so we can detect signed-out → signed-in
  // transitions specifically (vs initial hydration / token refresh, which
  // shouldn't navigate). Initialized after getSession() resolves.
  const prevSignedInRef = useRef<boolean>(false);
  useEffect(() => {
    supabase.auth.getSession().then(({ data }) => {
      setSession(data.session);
      setAuthReady(true);
      prevSignedInRef.current = !!data.session;
    });
    const { data: sub } = supabase.auth.onAuthStateChange((event, sess) => {
      const wasSignedIn = prevSignedInRef.current;
      const isSignedIn = !!sess;
      setSession(sess);
      if (event === 'SIGNED_IN' || event === 'SIGNED_OUT' || event === 'USER_UPDATED') {
        queryClient.clear();
      }
      // Reset to /applications on a fresh sign-in (after a prior signed-out
      // state) so a new account doesn't land on the previous user's last URL.
      // Only fires for SIGNED_IN events, not INITIAL_SESSION / TOKEN_REFRESHED
      // — bookmarks + reloads on an existing session stay on the current URL.
      if (event === 'SIGNED_IN' && !wasSignedIn) {
        navigate('/applications');
      }
      prevSignedInRef.current = isSignedIn;
    });
    return () => sub.subscription.unsubscribe();
  }, [queryClient, navigate]);

  // Onboarding flag — server-side per-user (public.users.onboarded_at). The
  // earlier localStorage approach was destructive (cleared on sign-out, not
  // scoped by user_id) so users re-saw the tour every time they signed back
  // in and on every new account. Source of truth is now the DB; survives
  // sign-out, scoped to auth.uid() via RLS.
  const { data: onboardedAt, isLoading: profileLoading } = useOnboardedAt();
  const markOnboarded = useMarkOnboarded();
  const resetOnboarded = useResetOnboarded();
  useEffect(() => {
    if (signedIn && !profileLoading && !onboardedAt) {
      setShowTour(true);
    }
  }, [signedIn, profileLoading, onboardedAt]);

  const handleSignOut = async () => {
    await supabase.auth.signOut();
    setProfileOpen(false);
  };
  const handleTourClose = () => {
    setShowTour(false);
    markOnboarded.mutate();
  };
  const handleShowTour = () => {
    resetOnboarded.mutate();
    setShowTour(true);
    setProfileOpen(false);
  };

  // While the session hydrates on mount, render nothing — avoids a flash of
  // the LoginScreen for users with a valid token.
  if (!authReady) {
    return <div style={{ height: '100vh', width: '100vw', background: 'var(--bg)' }} />;
  }

  return (
    <div style={{ display: 'flex', height: '100vh', width: '100vw', background: 'var(--bg)' }}>
      {!signedIn && <LoginScreen />}

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
          <Route
            path="/applications"
            element={
              <ApplicationsPage
                apps={apps}
                companies={companies}
                isLoading={appsQuery.isLoading}
                onOpenApp={setOpenApp}
                onMoveCard={(id, stage) => updateApp.mutate({ id, patch: { stage } })}
                onOpenAddModal={() => setAddModalOpen(true)}
                onImportDemo={() => importDemo.mutate()}
                importing={importDemo.isPending}
              />
            }
          />
          <Route path="/sync" element={<SyncRoute />} />
          <Route path="/resume-match" element={<ResumeMatchRoute />} />
          <Route path="/jd-breakdown" element={<JDBreakdownRoute />} />
          <Route path="/resumes" element={<ResumesPage />} />
          <Route path="*" element={<Navigate to="/applications" replace />} />
        </Routes>
      </main>

      {openApp && (
        <DetailDrawer
          appId={openApp}
          apps={apps}
          companies={companies}
          onClose={() => setOpenApp(null)}
          onUpdate={(id, patch) => updateApp.mutate({ id, patch })}
        />
      )}

      <AddApplicationModal
        open={addModalOpen}
        onClose={() => setAddModalOpen(false)}
        onAdd={(input) => addApp.mutateAsync(input)}
      />
    </div>
  );
}

function ApplicationsPage({
  apps,
  companies,
  isLoading,
  onOpenApp,
  onMoveCard,
  onOpenAddModal,
  onImportDemo,
  importing,
}: {
  apps: any[];
  companies: any[];
  isLoading: boolean;
  onOpenApp: (id: string) => void;
  onMoveCard: (id: string, stage: string) => void;
  onOpenAddModal: () => void;
  onImportDemo: () => void;
  importing: boolean;
}) {
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
        const c = companies.find((x: any) => x.id === a.companyId);
        return (
          (c?.name || '').toLowerCase().includes(q) ||
          a.role.toLowerCase().includes(q) ||
          (a.team || '').toLowerCase().includes(q)
        );
      });
    }
    return list;
  }, [apps, companies, filter, query]);

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

  const showEmpty = usePreviewEmpty() || (!isLoading && apps.length === 0);

  if (showEmpty) {
    return (
      <>
        <PageHeader
          title="Applications"
          subtitle="No applications yet — add one, or import demo data to look around"
          actions={
            <button
              onClick={onImportDemo}
              disabled={importing}
              className="btn-secondary"
              style={{ opacity: importing ? 0.6 : 1 }}
            >
              <Icon name="sparkle" size={13} /> {importing ? 'Importing…' : 'Try with demo data'}
            </button>
          }
        />
        <EmptyApplicationsView onAddManual={onOpenAddModal} onConnectPortal={() => {}} />
      </>
    );
  }

  return (
    <>
      <PageHeader
        title="Applications"
        subtitle={
          isLoading
            ? 'Loading…'
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
            <button className="btn-primary" onClick={onOpenAddModal}>
              <Icon name="plus" size={13} stroke={2} /> Add
            </button>
          </>
        }
      />
      <StatsBanner apps={apps} />
      <div style={{ flex: 1, overflow: 'hidden', position: 'relative' }}>
        <ViewComp apps={filteredApps} companies={companies} onOpen={onOpenApp} onMoveCard={onMoveCard} />
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

