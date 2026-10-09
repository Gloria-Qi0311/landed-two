// TanStack Query hooks for the resumes table. Same pattern as
// hooks/queries.ts (applications + companies). Each user has 0..N resumes;
// at most ONE row has is_current = true (partial unique index on the table
// enforces this, and the server demotes + promotes in one transaction).
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { api } from '../lib/api'
import { useAuth } from '../lib/auth'
import type { Resume } from '@landed/schema'

type DbResume = {
  id: string
  user_id: string
  name: string
  file_path: string | null
  parsed_json: Resume | null
  is_current: boolean
  created_at: string
}

export type ResumeRow = DbResume

export function useResumes() {
  const signedIn = useAuth((s) => !!s.user)
  return useQuery({
    queryKey: ['resumes'],
    enabled: signedIn,
    queryFn: () => api.get<DbResume[]>('/resumes'),
  })
}

export function useCurrentResume() {
  const { data: all, ...rest } = useResumes()
  const current = all?.find((r) => r.is_current) ?? null
  return { data: current, ...rest }
}

export function useAddResume() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (input: { name: string; parsed: Resume; setCurrent?: boolean }) =>
      api.post<DbResume>('/resumes', {
        name: input.name,
        parsed_json: input.parsed,
        set_current: !!input.setCurrent,
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['resumes'] })
    },
  })
}

export function useUpdateResume() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: ({ id, patch }: { id: string; patch: Partial<Pick<DbResume, 'name' | 'parsed_json'>> }) =>
      api.patch<DbResume>(`/resumes/${id}`, patch),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['resumes'] })
    },
  })
}

export function useDeleteResume() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: async (id: string) => {
      await api.del(`/resumes/${id}`)
      return id
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['resumes'] })
    },
  })
}

/** Mark a resume as the user's current resume (server demotes the previous
 *  one in the same transaction). */
export function useSetCurrentResume() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: async (id: string) => {
      await api.post(`/resumes/${id}/current`)
      return id
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['resumes'] })
    },
  })
}
