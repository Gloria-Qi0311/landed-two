// TanStack Query hooks for resumes, over the active data store (this device
// or Landed Cloud — see lib/store). Same pattern as hooks/queries.ts. Each
// user has 0..N resumes; at most ONE has is_current = true, and both stores
// demote + promote atomically.
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { useStore, type DbResume } from '../lib/store'
import type { Resume } from '@landed/schema'

export type ResumeRow = DbResume

export function useResumes() {
  const { store, ready } = useStore()
  return useQuery({
    queryKey: ['resumes', store.kind],
    enabled: ready,
    queryFn: () => store.listResumes(),
  })
}

export function useCurrentResume() {
  const { data: all, ...rest } = useResumes()
  const current = all?.find((r) => r.is_current) ?? null
  return { data: current, ...rest }
}

export function useAddResume() {
  const qc = useQueryClient()
  const { store } = useStore()
  return useMutation({
    mutationFn: (input: { name: string; parsed: Resume; setCurrent?: boolean }) =>
      store.addResume({ name: input.name, parsed_json: input.parsed, set_current: !!input.setCurrent }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['resumes'] })
    },
  })
}

export function useUpdateResume() {
  const qc = useQueryClient()
  const { store } = useStore()
  return useMutation({
    mutationFn: ({ id, patch }: { id: string; patch: Partial<Pick<DbResume, 'name' | 'parsed_json'>> }) =>
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
