// Cloud store — the same DataStore contract, backed by the Landed API
// server (apps/server). Active for accounts with Landed Cloud sync on.
import { api } from '../api'
import type {
  DataStore, DbAgentObservation, DbApplication, DbJobLead, DbJobSearch, DbSuggestion, DbCompany, DbPortalConnection, DbPortalEvent, DbResume, Snapshot,
} from './types'

export function createCloudStore(): DataStore {
  return {
    kind: 'cloud',

    listCompanies: () => api.get<DbCompany[]>('/companies'),
    listApplications: () => api.get<DbApplication[]>('/applications'),
    addApplication: (company, application) => api.post<DbApplication>('/applications', { company, application }),
    updateApplication: (id, patch) => api.patch<DbApplication>(`/applications/${id}`, patch),
    importDemo: (data) => api.post('/import', data),

    listResumes: () => api.get<DbResume[]>('/resumes'),
    addResume: (input) => api.post<DbResume>('/resumes', input),
    updateResume: (id, patch) => api.patch<DbResume>(`/resumes/${id}`, patch),
    deleteResume: (id) => api.del(`/resumes/${id}`),
    setCurrentResume: (id) => api.post<DbResume>(`/resumes/${id}/current`),

    listPortalConnections: () => api.get<DbPortalConnection[]>('/portal-connections'),
    upsertPortalConnection: (input) => api.put<DbPortalConnection>('/portal-connections', input),
    listPortalEvents: (limit) => api.get<DbPortalEvent[]>(`/portal-events?limit=${limit}`),
    addPortalEvents: async (rows) => (await api.post<{ rows: DbPortalEvent[] }>('/portal-events', rows)).rows,
    // SSE fed by Postgres LISTEN/NOTIFY; the server only streams this user's
    // rows. EventSource reconnects on its own after network drops.
    subscribePortalEvents(onInsert) {
      const source = new EventSource('/api/portal-events/stream')
      source.addEventListener('portal_event', (e) => {
        try {
          onInsert(JSON.parse((e as MessageEvent).data) as DbPortalEvent)
        } catch {
          // malformed frame — ignore
        }
      })
      return () => source.close()
    },

    addAiRun: (row) => api.post<{ id: string }>('/ai-runs', row),

    listAgentObservations: (limit) => api.get<DbAgentObservation[]>(`/agent-observations?limit=${limit}`),
    listPendingObservations: (limit) => api.get<DbAgentObservation[]>(`/agent-observations/pending?limit=${limit}`),
    markObservation: async (id, processing_status, processing_result) => {
      await api.patch(`/agent-observations/${id}`, { processing_status, processing_result })
    },

    listJobLeads: () => api.get<DbJobLead[]>('/job-leads'),
    saveJobLead: (lead) => api.put<DbJobLead>(`/job-leads/${lead.id}`, lead),
    updateJobLead: (id, patch) => api.patch<DbJobLead>(`/job-leads/${id}`, patch),

    listSuggestions: () => api.get<DbSuggestion[]>('/status-suggestions'),
    saveSuggestion: (s) => api.put<DbSuggestion>(`/status-suggestions/${s.id}`, s),
    updateSuggestion: (id, patch) => api.patch<DbSuggestion>(`/status-suggestions/${id}`, patch),

    listJobSearches: () => api.get<DbJobSearch[]>('/job-searches'),
    addJobSearch: (brief) => api.post<DbJobSearch>('/job-searches', { brief }),
    updateJobSearch: (id, patch) => api.patch<DbJobSearch>(`/job-searches/${id}`, patch),

    exportSnapshot: () => api.get<Snapshot>('/export'),
  }
}
