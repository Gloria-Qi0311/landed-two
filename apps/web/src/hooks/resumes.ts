// TanStack Query hooks for resumes, over the active data store (this device
// or Landed Cloud — see lib/store). Same pattern as hooks/queries.ts. Each
// user has 0..N resumes; at most ONE has is_current = true, and both stores
// demote + promote atomically.
import { useEffect } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { useAuth } from '../lib/auth'
import { useResumeTask } from '../lib/resume-tasks'
import { agentFor, useRuntimes } from './runtimes'
import { useStore, type DbResume } from '../lib/store'

export type ResumeRow = DbResume

export function useResumes() {
  const { store, ready } = useStore()
  return useQuery({
    queryKey: ['resumes', store.kind],
    enabled: ready,
    queryFn: () => store.listResumes(),
  })
}

/** My Resume's three groups: the master, versions (newest first), uploads. */
export function useResumeGroups() {
  const all = useResumes().data ?? []
  return {
    master: all.find((r) => r.kind === 'master') ?? null,
    versions: all.filter((r) => r.kind === 'version'),
    sources: all.filter((r) => (r.kind ?? 'source') === 'source'),
  }
}

export function useCurrentResume() {
  const { data: all, ...rest } = useResumes()
  const current = all?.find((r) => r.is_current) ?? null
  return { data: current, ...rest }
}

export function useUpdateResume() {
  const qc = useQueryClient()
  const { store } = useStore()
  return useMutation({
    mutationFn: ({ id, patch }: { id: string; patch: Partial<Pick<DbResume, 'name' | 'parsed_json' | 'master_json' | 'target_json' | 'directions'>> }) =>
      store.updateResume(id, patch),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['resumes'] })
    },
  })
}

export function useDeleteResume() {
  const qc = useQueryClient()
  const { store } = useStore()
  return useMutation({
    mutationFn: async (id: string) => {
      await store.deleteResume(id)
      return id
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['resumes'] })
    },
  })
}

/** Mark a resume as the user's current resume (the store demotes the
 *  previous one in the same transaction). */
export function useSetCurrentResume() {
  const qc = useQueryClient()
  const { store } = useStore()
  return useMutation({
    mutationFn: async (id: string) => {
      await store.setCurrentResume(id)
      return id
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['resumes'] })
    },
  })
}

/** Mount once below the login gate: lets a merge/tailor finish (and resume
 *  after a reload) wherever the user is. */
export function useResumeTaskRunner() {
  const qc = useQueryClient()
  const { store, ready } = useStore()
  const userId = useAuth((s) => s.user?.id)
  useEffect(() => {
    if (!ready || !userId) return
    useResumeTask.getState().bind(userId, {
      store,
      onData: () => {
        qc.invalidateQueries({ queryKey: ['resumes'] })
        qc.invalidateQueries({ queryKey: ['application_files'] })
        qc.invalidateQueries({ queryKey: ['resume_files'] })
      },
    })
  }, [ready, userId, store, qc])

  // A resume uploaded without a computer is read in full as soon as one is
  // connected, wherever the user is (lib/resume-tasks.ts, readWaiting).
  const resumes = useResumes().data
  const reader = agentFor(useRuntimes().data, 'resume_parse')
  useEffect(() => {
    if (!ready || !userId || !reader.agent) return
    for (const r of resumes ?? []) {
      if (r.kind === 'source' && r.file_path) void useResumeTask.getState().readWaiting({ runtime: reader.runtime, agent: reader.agent }, r)
    }
  }, [ready, userId, resumes, reader.runtime, reader.agent])
}
