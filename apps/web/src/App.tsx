import { useState, useEffect, useMemo, useRef } from 'react';
import { Routes, Route, Navigate, useSearchParams, useNavigate } from 'react-router-dom';
import { useQueryClient } from '@tanstack/react-query';
import { useOnboardedAt, useMarkOnboarded, useResetOnboarded } from './hooks/profile';
import { useExtensionBridge } from './hooks/extension-bridge';
import { useAgentRelay } from './hooks/agents';
import { useJobLeads, useObservationProcessor, useSuggestions } from './hooks/inbox';
import { AgentsPage } from './components/agents-page';
import { LeadsPage } from './components/leads-page';
import { ReviewPage } from './components/review-page';

import { useAuth } from './lib/auth';
import {
  useApplications,
  useCompanies,
  useUpdateApplication,
  useAddApplication,
  useImportDemoData,
} from './hooks/queries';
import { Sidebar, PageHeader, StatsBanner } from './components/shell';
import { LoginScreen, OnboardingTour, ProfileMenu } from './components/auth';
import { OfflineNotice, RestoreBackupDialog, TurnOffCloudDialog, TurnOnCloudDialog } from './components/cloud';
import { downloadBackup, readBackupFile, signOut } from './lib/cloud';
import { currentStore, type Snapshot } from './lib/store';
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

// Login gate. Everyone signs in; the account's cloud_sync flag then decides
// where its data lives (lib/store). SignedInApp remounts — and the query
// cache is cleared — whenever the account or its sync mode changes, so no
// rows or UI state carry over between the two.
export function App() {
  const [theme, setTheme] = useState<string>(
    () => localStorage.getItem('landed:theme') || 'cool'
  );
  const user = useAuth((s) => s.user);
  const authReady = useAuth((s) => s.ready);
  const hydrateAuth = useAuth((s) => s.hydrate);
  const queryClient = useQueryClient();
  const navigate = useNavigate();

  // Theme: apply on <body> + persist (the login screen is themed too)
  useEffect(() => {
    document.body.setAttribute('data-theme', theme);
    localStorage.setItem('landed:theme', theme);
  }, [theme]);

  useEffect(() => {
    hydrateAuth();
  }, [hydrateAuth]);

  // Account + mode identity. Undefined until hydrated, so the initial
  // hydration (reloads, bookmarks) doesn't count as a switch.
  const sessionKey = user ? `${user.id}:${user.cloud_sync ? 'cloud' : 'local'}` : null;
  const prevKeyRef = useRef<string | null | undefined>(undefined);
  useEffect(() => {
    if (!authReady) return;
    const prev = prevKeyRef.current;
    prevKeyRef.current = sessionKey;
    if (prev === undefined || prev === sessionKey) return;
    queryClient.clear();
    // Fresh start on /applications so nobody lands on a URL that only made
    // sense for the previous account or mode.
    navigate('/applications');
  }, [authReady, sessionKey, queryClient, navigate]);

  // While the session probe runs, render nothing — avoids flashing the
  // login screen at a signed-in user.
  if (!authReady) {
    return <div style={{ height: '100vh', width: '100vw', background: 'var(--bg)' }} />;
  }
  if (!user) return <LoginScreen />;
  return <SignedInApp key={sessionKey!} theme={theme} setTheme={setTheme} />;
}

function SignedInApp({ theme, setTheme }: { theme: string; setTheme: (t: string) => void }) {
  const [openApp, setOpenApp] = useState<string | null>(null);
  const [addModalOpen, setAddModalOpen] = useState(false);

  const user = useAuth((s) => s.user)!;
  const account = { mode: user.cloud_sync ? ('cloud' as const) : ('local' as const), email: user.email };
  const [dialog, setDialog] = useState<null | 'sync-on' | 'sync-off' | { restore: Snapshot }>(null);
  const backupInput = useRef<HTMLInputElement>(null);
  const [accountError, setAccountError] = useState<string | null>(null);
  const [profileOpen, setProfileOpen] = useState(false);
  const [showTour, setShowTour] = useState(false);
  const queryClient = useQueryClient();

  // Data layer (TanStack Query → the account's store: this device's
  // database, or Landed Cloud when the account syncs).
  const appsQuery = useApplications();
  useExtensionBridge();
  useAgentRelay();
  useObservationProcessor();
  const sidebarCounts = {
    leads: (useJobLeads().data ?? []).filter((l) => l.status === 'new').length,
    review: (useSuggestions().data ?? []).filter((s) => s.state === 'pending').length,
  };
  const companiesQuery = useCompanies();
  const updateApp = useUpdateApplication();
  const addApp = useAddApplication();
  const importDemo = useImportDemoData();

  // Companies for rendering: prefer the user's table; fall back to the
  // catalog so newly-added apps don't visually break before the next refetch.
  const companies = (companiesQuery.data && companiesQuery.data.length > 0)
    ? companiesQuery.data
    : COMPANY_CATALOG;
  // Every view looks an application's company up by id, but the two queries
  // resolve independently (on a fresh load or mode switch, and right after
  // an add the new company lands a beat after the app). Only hand the views
  // applications whose company has arrived; the rest show up a moment later.
  const companyIds = useMemo(() => new Set(companies.map((c: { id: string }) => c.id)), [companies]);
  const apps = useMemo(
    () => (appsQuery.data ?? []).filter((a) => companyIds.has(a.companyId)),
    [appsQuery.data, companyIds],
  );

  // Onboarding flag — account-level on the server (users.onboarded_at), so
  // the tour shows once per account on any device. The earlier localStorage
  // flag was destructive (cleared on sign-out, not scoped by user) and was
  // removed. Only acts on a successful read, so offline mode skips the tour.
  const { data: onboardedAt, isSuccess: profileLoaded } = useOnboardedAt();
  const markOnboarded = useMarkOnboarded();
  const resetOnboarded = useResetOnboarded();
  useEffect(() => {
    if (profileLoaded && !onboardedAt) {
      setShowTour(true);
    }
  }, [profileLoaded, onboardedAt]);

  const handleSignOut = async () => {
    setProfileOpen(false);
    await signOut();
  };
  const handleExport = async () => {
    setAccountError(null);
    try {
      downloadBackup(await currentStore().exportSnapshot());
    } catch (e) {
      setAccountError(`Export failed: ${(e as Error).message}`);
    }
  };
  const handleBackupFile = async (file: File | undefined) => {
    if (!file) return;
    setAccountError(null);
    try {
      setDialog({ restore: await readBackupFile(file) });
    } catch (e) {
      setAccountError((e as Error).message);
    }
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

  return (
    <div style={{ display: 'flex', height: '100vh', width: '100vw', background: 'var(--bg)' }}>
      <Sidebar apps={apps} account={account} navCounts={sidebarCounts} onProfileClick={() => setProfileOpen((o) => !o)} />

      <ProfileMenu
        open={profileOpen}
        onClose={() => setProfileOpen(false)}
        account={account}
        onShowTour={handleShowTour}
        theme={theme}
        setTheme={setTheme}
        onTurnOnCloud={() => setDialog('sync-on')}
        onLeaveCloud={() => setDialog('sync-off')}
        onSignOut={handleSignOut}
        onExport={handleExport}
        onImport={() => backupInput.current?.click()}
      />
      <input
        ref={backupInput}
        type="file"
        accept="application/json,.json"
        style={{ display: 'none' }}
        onChange={(e) => {
          handleBackupFile(e.target.files?.[0]);
          e.target.value = '';
        }}
      />

      {showTour && <OnboardingTour onClose={handleTourClose} />}
      {dialog === 'sync-on' && <TurnOnCloudDialog onClose={() => setDialog(null)} />}
      {dialog === 'sync-off' && <TurnOffCloudDialog onClose={() => setDialog(null)} />}
      {dialog && typeof dialog === 'object' && (
        <RestoreBackupDialog
          snapshot={dialog.restore}
          onClose={() => setDialog(null)}
          onRestored={() => queryClient.invalidateQueries()}
        />
      )}

      <main style={{ flex: 1, display: 'flex', flexDirection: 'column', minWidth: 0, height: '100%' }}>
        <OfflineNotice />
        {accountError && (
          <div role="alert" style={{ margin: '10px 28px 0', padding: '8px 12px', borderRadius: 8, fontSize: 12, background: 'oklch(0.97 0.03 30)', border: '0.5px solid oklch(0.88 0.06 30)', color: 'oklch(0.45 0.15 30)', display: 'flex', gap: 10 }}>
            <span style={{ flex: 1 }}>{accountError}</span>
            <button type="button" className="btn-secondary" onClick={() => setAccountError(null)}>Dismiss</button>
          </div>
        )}
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
          <Route path="/leads" element={<LeadsPage />} />
          <Route path="/review" element={<ReviewPage />} />
          <Route path="/agents" element={<AgentsPage />} />
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

