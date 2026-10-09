// Cloud store — the same DataStore contract, backed by the Landed API
// server (apps/server). Active while the user is signed in to Landed Cloud.
import { api } from '../api'
import type {
  DataStore, DbApplication, DbCompany, DbPortalConnection, DbPortalEvent, DbResume, Profile, Snapshot,
} from './types'

export function createCloudStore(): DataStore {
  return {
    kind: 'cloud',

    getProfile: () => api.get<Profile>('/me'),
    updateProfile: (patch) => api.patch<Profile>('/me', patch),

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

    exportSnapshot: () => api.get<Snapshot>('/export'),
  }
}
