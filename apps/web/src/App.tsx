import { lazy, Suspense, useCallback, useState, useEffect, useMemo, useRef, type ReactNode } from 'react';
import { Routes, Route, Navigate, useSearchParams, useNavigate, useLocation } from 'react-router-dom';
import { useQueryClient } from '@tanstack/react-query';
import { useOnboardedAt, useMarkOnboarded, useResetOnboarded } from './hooks/profile';
import { useExtensionBridge } from './hooks/extension-bridge';
import { useAgentRelay, useCloudBriefing } from './hooks/agents';
import { useJobLeads, useLeadActions, useObservationProcessor, useRecordApplyClick } from './hooks/inbox';
import { usePanelQuestions } from './components/panel-questions';
import { usePendingQuestions } from './components/pending-questions';
import { usePortalRunner } from './hooks/portal';
import { useResumeTaskRunner } from './hooks/resumes';
import { useKnownAnswers } from './hooks/answers';
import { useAgentChatRunner } from './hooks/conversations';
import { useSearchRunner } from './hooks/search';
import { useAutoSupply, useLeadScreening, usePutBack, useSupplyRefresh } from './hooks/supply';
import { screenedOut } from './lib/screen';
import { useAutomationRunner } from './hooks/automation';
import { useAutoApplyRunner } from './hooks/auto-apply';
import { AgentUpdatesBar, EmailCheckRunning, usePendingUpdateCount } from './components/agent-updates';

import { useAuth } from './lib/auth';
import {
  useApplications,
  useCompanies,
  useUpdateApplication, useDeleteApplication,
  useAddApplication,
  useImportDemoData,
} from './hooks/queries';
import { Sidebar, PageHeader } from './components/shell';
import { ExportApplicationsButton } from './components/export-button';
import { ImportApplicationsModal } from './components/import-applications';
import { LoginScreen, OnboardingTour, ProfileMenu } from './components/auth';
import { EmptyDeviceNotice, OfflineNotice, RestoreBackupDialog, TurnOffCloudDialog, TurnOnCloudDialog } from './components/cloud';
import { RecoveryCodesDialog } from './components/recovery-codes';
import { downloadBackup, readBackupFile, signOut } from './lib/cloud';
import { currentStore, type ApplicationPatch, type DbJobLead, type Snapshot } from './lib/store';
import type { Stage } from '@landed/observation-processor';
import { Icon } from './components/primitives';
import { KanbanView } from './components/kanban';
import { DetailDrawer } from './components/drawer';
import { AddApplicationModal } from './components/add-application-modal';
import {
  EmptyApplicationsView,
} from './components/empty-states';
import { COMPANIES as COMPANY_CATALOG } from './data';
import { AuthorizeAgentPage } from './components/authorize-agent';

// Keep the applications board as the fast default route. The three heavier
// workspaces are only downloaded when the user opens them; Resume in
// particular brings document parsing code that the board never needs.
const AgentPage = lazy(() => import('./components/agent-page').then((m) => ({ default: m.AgentPage })));
const WorkflowPage = lazy(() => import('./components/workflow-page').then((m) => ({ default: m.WorkflowPage })));
const ResumesPage = lazy(() => import('./components/resumes-page').then((m) => ({ default: m.ResumesPage })));
const ExtensionPage = lazy(() => import('./components/extension-page').then((m) => ({ default: m.ExtensionPage })));

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
  const location = useLocation();
  // A cloud agent's connect request (OAuth consent): sign in first if
  // needed, then the consent page, outside the app shell.
  const authorizing = location.pathname === '/authorize-agent';
  const resettingPassword = location.pathname === '/reset-password';
  const forgotPassword = location.pathname === '/forgot-password';

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
    // sense for the previous account or mode — except a connect request,
    // which is why they just signed in.
    if (!authorizing) navigate('/applications');
  }, [authReady, sessionKey, queryClient, navigate, authorizing]);

  // While the session probe runs, render nothing — avoids flashing the
  // login screen at a signed-in user.
  if (!authReady) {
    return <div style={{ height: '100vh', width: '100vw', background: 'var(--bg)' }} />;
  }
  if (resettingPassword) return <LoginScreen initialMode="reset" />;
  if (forgotPassword) return <LoginScreen initialMode="forgot" />;
  if (!user) return <LoginScreen />;
  if (authorizing) return <AuthorizeAgentPage />;
  return <SignedInApp key={sessionKey!} theme={theme} setTheme={setTheme} />;
}

function SignedInApp({ theme, setTheme }: { theme: string; setTheme: (t: string) => void }) {
  const [openApp, setOpenApp] = useState<string | null>(null);
  const [addModalOpen, setAddModalOpen] = useState(false);
  // Importing a spreadsheet: from Add, or the empty board.
  const [importOpen, setImportOpen] = useState(false);
  const closeImport = useCallback(() => setImportOpen(false), []);

  const user = useAuth((s) => s.user)!;
  const account = { mode: user.cloud_sync ? ('cloud' as const) : ('local' as const), email: user.email };
  const [dialog, setDialog] = useState<null | 'sync-on' | 'sync-off' | 'recovery-codes' | { restore: Snapshot }>(null);
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
  useCloudBriefing();
  useObservationProcessor();
  useSearchRunner();
  useAutoSupply();
  useLeadScreening();
  useAutomationRunner();
  useAutoApplyRunner();
  usePortalRunner();
  useResumeTaskRunner();
  useKnownAnswers();
  useAgentChatRunner();
  // Badges: updates waiting on Applications; Landed's questions on the Agent page.
  const sidebarCounts = { applications: usePendingUpdateCount(), agent: usePanelQuestions().count, extension: usePendingQuestions().length };
  const recordApplyClick = useRecordApplyClick();
  const companiesQuery = useCompanies();
  const updateApp = useUpdateApplication();
  const deleteApp = useDeleteApplication();
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
      <Sidebar account={account} navCounts={sidebarCounts} onProfileClick={() => setProfileOpen((o) => !o)} />

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
        onRecoveryCodes={() => setDialog('recovery-codes')}
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
      {dialog === 'recovery-codes' && <RecoveryCodesDialog onClose={() => setDialog(null)} />}
      {dialog && typeof dialog === 'object' && (
        <RestoreBackupDialog
          snapshot={dialog.restore}
          onClose={() => setDialog(null)}
          onRestored={() => queryClient.invalidateQueries()}
        />
      )}

      <main style={{ flex: 1, display: 'flex', flexDirection: 'column', minWidth: 0, height: '100%' }}>
        <OfflineNotice />
        <EmptyDeviceNotice onRestore={() => backupInput.current?.click()} />
        {accountError && (
          <div role="alert" style={{ margin: '10px 28px 0', padding: '8px 12px', borderRadius: 8, fontSize: 12, background: 'oklch(0.97 0.03 30)', border: '0.5px solid oklch(0.88 0.06 30)', color: 'oklch(0.45 0.15 30)', display: 'flex', gap: 10 }}>
            <span style={{ flex: 1 }}>{accountError}</span>
            <button type="button" className="btn-secondary" onClick={() => setAccountError(null)}>Dismiss</button>
          </div>
        )}
        <Suspense fallback={<div style={{ padding: 28, color: 'var(--text-muted)' }}>Loading…</div>}>
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
                  onOpenImport={() => setImportOpen(true)}
                  onImportDemo={() => importDemo.mutate()}
                  importing={importDemo.isPending}
                />
              }
            />
            <Route path="/resumes" element={<ResumesPage />} />
            <Route path="/extension" element={<ExtensionPage />} />
            {/* Removed pages: old links land somewhere useful. */}
            <Route path="/resume-match" element={<Navigate to="/resumes" replace />} />
            <Route path="/sync" element={<Navigate to="/applications" replace />} />
            <Route path="/jd-breakdown" element={<Navigate to="/applications" replace />} />
            <Route path="/agent" element={<AgentPage />} />
            <Route path="/workflow" element={<WorkflowPage />} />
            <Route path="/automation" element={<Navigate to="/workflow" replace />} />
            <Route path="/agents" element={<Navigate to="/agent?view=settings" replace />} />
            <Route path="*" element={<Navigate to="/applications" replace />} />
          </Routes>
        </Suspense>
      </main>

      {openApp && (
        <DetailDrawer
          appId={openApp}
          apps={apps}
          companies={companies}
          onClose={() => setOpenApp(null)}
          onUpdate={(id: string, patch: ApplicationPatch) => updateApp.mutate({ id, patch })}
          onDelete={async (id: string) => {
            await deleteApp.mutateAsync(id)
            setOpenApp(null)
          }}
          onOpenPosting={(app: { id: string; role: string; stage: string }, company: { name: string }) =>
            recordApplyClick({ kind: 'application', id: app.id, role: app.role, stage: app.stage, company_name: company.name })}
        />
      )}

      <AddApplicationModal
        open={addModalOpen}
        onClose={() => setAddModalOpen(false)}
        onAdd={(input: Parameters<typeof addApp.mutateAsync>[0]) => addApp.mutateAsync(input)}
        onImport={() => { setAddModalOpen(false); setImportOpen(true) }}
      />
      <ImportApplicationsModal key="import" open={importOpen} onClose={closeImport} />
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
  onOpenImport,
  onImportDemo,
  importing,
}: {
  apps: any[];
  companies: any[];
  isLoading: boolean;
  onOpenApp: (id: string) => void;
  onMoveCard: (id: string, stage: string) => void;
  onOpenAddModal: () => void;
  onOpenImport: () => void;
  onImportDemo: () => void;
  importing: boolean;
}) {
  const [searchParams] = useSearchParams();
  // Old links to the agent side panel (?agent=chat|settings) → the Agent page.
  const legacyAgent = searchParams.get('agent');
  const navigate = useNavigate();
  const page = (content: ReactNode) => (
    <div style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column' }}>{content}</div>
  );

  // Jobs agents and job lists found but the user hasn't acted on — the
  // Kanban's Leads column. Postings that closed leave it (the data stays;
  // the column folds them away under "Closed", newest first). The hard
  // filters (#92) hide what plainly can't be applied to; the column lists
  // those apart, with their reasons and a way back.
  const allLeads = useJobLeads().data ?? [];
  const open = allLeads.filter((l) => l.status === 'new' && !l.closed_at);
  const closedLeads = allLeads.filter((l) => l.status === 'new' && l.closed_at)
    .sort((a, b) => b.closed_at!.localeCompare(a.closed_at!));
  const leadByApp = new Map(allLeads.filter((l) => l.application_id).map((l) => [l.application_id!, l]));
  const leads = open.filter((l) => !screenedOut(l));
  const filteredLeads = open.filter(screenedOut);
  const leadsRefresh = useSupplyRefresh();
  const putBack = usePutBack();
  const leadActions = useLeadActions();
  const updateApplication = useUpdateApplication();
  const recordApplyClick = useRecordApplyClick();

  const showEmpty = usePreviewEmpty() || (!isLoading && apps.length === 0 && open.length === 0);
  if (legacyAgent) return <Navigate to={legacyAgent === 'settings' ? '/agent?view=settings' : '/agent'} replace />;

  if (showEmpty) {
    return page(
      <>
        <PageHeader
          title="Applications"
          subtitle="No applications yet — add one, import demo data, or ask your agent to help you start"
          actions={
            <>
              <button
                onClick={onImportDemo}
                disabled={importing}
                className="btn-secondary"
                style={{ opacity: importing ? 0.6 : 1 }}
              >
                <Icon name="sparkle" size={13} /> {importing ? 'Importing…' : 'Try with demo data'}
              </button>
              <button className="btn-primary" onClick={() => navigate('/agent')}>
                <Icon name="sparkle" size={13} /> Ask your agent
              </button>
            </>
          }
        />
        <EmptyApplicationsView onAddManual={onOpenAddModal} onTrackStatus={() => navigate('/workflow#email')} onImport={onOpenImport} />
      </>
    );
  }

  return page(
    <>
      <PageHeader
        title="Applications"
        subtitle={
          isLoading
            ? 'Loading…'
            : `${apps.length} application${apps.length === 1 ? '' : 's'} · ${new Set(apps.map((a) => a.companyId)).size} companies`
        }
        actions={
          <>
            <ExportApplicationsButton />
            <button className="btn-primary" onClick={onOpenAddModal}>
              <Icon name="plus" size={13} stroke={2} /> Add
            </button>
          </>
        }
      />
      <EmailCheckRunning />
      <AgentUpdatesBar />
      <div style={{ flex: 1, overflow: 'hidden', position: 'relative' }}>
        <KanbanView
          apps={apps}
          companies={companies}
          onOpen={onOpenApp}
          onMoveCard={onMoveCard}
          leads={leads}
          queueLeads={allLeads}
          onAddLead={(lead: DbJobLead, stage: Stage) => leadActions.add.mutate({ lead, stage })}
          onDismissLead={(id: string) => leadActions.dismiss.mutate(id)}
          onOpenLead={(lead: DbJobLead) => recordApplyClick({ kind: 'lead', lead })}
          onSetLeadDeadline={(id: string, deadline: string | null) => leadActions.setDeadline.mutate({ id, deadline })}
          onSetAppDeadline={(id: string, deadline: string | null) => updateApplication.mutate({ id, patch: { deadline } })}
          leadsRefresh={leadsRefresh}
          filteredLeads={filteredLeads}
          onPutBackLead={(lead: DbJobLead) => putBack.mutate(lead)}
          closedLeads={closedLeads}
          leadForApp={(id: string) => leadByApp.get(id)}
          onApproveLeads={(picked: DbJobLead[]) => leadActions.approve.mutateAsync(picked)}
          onUndoApprove={(approvals) => leadActions.undoApprove.mutateAsync(approvals)}
        />
      </div>
    </>
  );
}

