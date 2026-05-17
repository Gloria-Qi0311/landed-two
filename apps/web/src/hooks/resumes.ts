// TanStack Query hooks for the resumes table. Same pattern as
// hooks/queries.ts (applications + companies). Each user has 0..N resumes
// in their RLS-scoped slice of public.resumes; at most ONE row has
// is_current = true (partial unique index on the table enforces this).
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { supabase } from '../lib/supabase'
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
  return useQuery({
    queryKey: ['resumes'],
    queryFn: async () => {
      const { data, error } = await supabase
        .from('resumes')
        .select('*')
        .order('created_at', { ascending: false })
      if (error) throw error
      return (data ?? []) as DbResume[]
    },
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
    mutationFn: async (input: { name: string; parsed: Resume; setCurrent?: boolean }) => {
      const userRes = await supabase.auth.getUser()
      const userId = userRes.data.user?.id
      if (!userId) throw new Error('not signed in')

      // If this resume should be current, demote any existing current first.
      // Best-effort: two-step (demote, then insert) — a concurrent insert
      // from another tab in the gap could violate the partial unique index
      // resumes_one_current_per_user_idx. Acceptable for solo-user, would
      // become a Supabase RPC (transactional) if multi-tab editing matters.
      if (input.setCurrent) {
        await supabase.from('resumes').update({ is_current: false }).eq('is_current', true)
      }

      const { data, error } = await supabase
        .from('resumes')
        .insert({
          user_id: userId,
          name: input.name,
          parsed_json: input.parsed,
          is_current: !!input.setCurrent,
        })
        .select()
        .single()
      if (error) throw error
      return data as DbResume
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['resumes'] })
    },
  })
}

export function useUpdateResume() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: async ({ id, patch }: { id: string; patch: Partial<Pick<DbResume, 'name' | 'parsed_json'>> }) => {
      const { data, error } = await supabase
        .from('resumes')
        .update(patch)
        .eq('id', id)
        .select()
        .single()
      if (error) throw error
      return data as DbResume
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['resumes'] })
    },
  })
}

export function useDeleteResume() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: async (id: string) => {
      const { error } = await supabase.from('resumes').delete().eq('id', id)
      if (error) throw error
      return id
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['resumes'] })
    },
  })
}

/**
 * Mark a resume as the user's current resume. Demotes any previously-current
 * row first so the partial unique index `resumes_one_current_per_user_idx`
 * doesn't reject the update. Same race caveat as useAddResume(setCurrent: true):
 * concurrent multi-tab promotion could conflict; acceptable for now, RPC later.
 */
export function useSetCurrentResume() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: async (id: string) => {
      // Demote everyone else first
      await supabase
        .from('resumes')
        .update({ is_current: false })
        .eq('is_current', true)
      // Promote the chosen one
      const { error } = await supabase
        .from('resumes')
        .update({ is_current: true })
        .eq('id', id)
      if (error) throw error
      return id
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['resumes'] })
    },
  })
}
