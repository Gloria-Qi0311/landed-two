// Profile hooks — reads / writes public.users (1:1 with auth.users).
//
// Currently exposes only the onboarding flag (public.users.onboarded_at).
// Other profile fields (display_name, avatar_url, etc.) land here when the
// app needs them.
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { supabase } from '../lib/supabase'

const KEY = ['profile', 'onboarded_at'] as const

export function useOnboardedAt() {
  return useQuery({
    queryKey: KEY,
    queryFn: async () => {
      const { data: { user } } = await supabase.auth.getUser()
      if (!user) return null
      const { data, error } = await supabase
        .from('users')
        .select('onboarded_at')
        .eq('id', user.id)
        .maybeSingle()
      if (error) throw error
      return (data?.onboarded_at as string | null) ?? null
    },
  })
}

export function useMarkOnboarded() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: async () => {
      const { data: { user } } = await supabase.auth.getUser()
      if (!user) throw new Error('not signed in')
      const at = new Date().toISOString()
      const { error } = await supabase
        .from('users')
        .update({ onboarded_at: at })
        .eq('id', user.id)
      if (error) throw error
      return at
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: KEY }),
  })
}

export function useResetOnboarded() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: async () => {
      const { data: { user } } = await supabase.auth.getUser()
      if (!user) throw new Error('not signed in')
      const { error } = await supabase
        .from('users')
        .update({ onboarded_at: null })
        .eq('id', user.id)
      if (error) throw error
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: KEY }),
  })
}
