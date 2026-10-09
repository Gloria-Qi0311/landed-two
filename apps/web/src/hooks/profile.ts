// Profile hooks — reads / writes the signed-in user's row in users.
//
// Currently exposes only the onboarding flag (users.onboarded_at). Other
// profile fields (display_name, avatar_url, etc.) land here when the app
// needs them.
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { api } from '../lib/api'
import { useAuth } from '../lib/auth'

const KEY = ['profile', 'onboarded_at'] as const

type Me = { onboarded_at: string | null }

export function useOnboardedAt() {
  const signedIn = useAuth((s) => !!s.user)
  return useQuery({
    queryKey: KEY,
    enabled: signedIn,
    queryFn: async () => (await api.get<Me>('/me')).onboarded_at ?? null,
  })
}

export function useMarkOnboarded() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: async () => {
      const at = new Date().toISOString()
      await api.patch<Me>('/me', { onboarded_at: at })
      return at
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: KEY }),
  })
}

export function useResetOnboarded() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: async () => {
      await api.patch<Me>('/me', { onboarded_at: null })
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: KEY }),
  })
}
