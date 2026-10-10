// Profile hooks — the onboarding flag (users.onboarded_at). It's account-
// level (shown once per account, on any device), so it always lives on the
// server, whether or not the account's data syncs to Landed Cloud. Other
// profile fields (display_name, avatar_url, etc.) land here when needed.
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { api } from '../lib/api'
import { useAuth } from '../lib/auth'

const KEY = ['profile', 'onboarded_at'] as const

type Me = { onboarded_at: string | null }

export function useOnboardedAt() {
  // Offline (server unreachable) there's no profile to read — the caller
  // only shows the tour on a successful read.
  const online = useAuth((s) => s.ready && !s.offline && !s.unreachable)
  return useQuery({
    queryKey: KEY,
    enabled: online,
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
