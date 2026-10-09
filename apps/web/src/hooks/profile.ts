// Profile hooks — the onboarding flag (onboarded_at), over the active data
// store: this device's local profile, or users.onboarded_at in Landed Cloud.
// Other profile fields (display_name, avatar_url, etc.) land here when the
// app needs them.
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { useStore } from '../lib/store'

const KEY = ['profile', 'onboarded_at'] as const

export function useOnboardedAt() {
  const { store, ready } = useStore()
  return useQuery({
    queryKey: [...KEY, store.kind],
    enabled: ready,
    queryFn: async () => (await store.getProfile()).onboarded_at ?? null,
  })
}

export function useMarkOnboarded() {
  const qc = useQueryClient()
  const { store } = useStore()
  return useMutation({
    mutationFn: async () => {
      const at = new Date().toISOString()
      await store.updateProfile({ onboarded_at: at })
      return at
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: KEY }),
  })
}

export function useResetOnboarded() {
  const qc = useQueryClient()
  const { store } = useStore()
  return useMutation({
    mutationFn: async () => {
      await store.updateProfile({ onboarded_at: null })
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: KEY }),
  })
}
