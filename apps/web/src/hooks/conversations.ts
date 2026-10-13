// Agent chat history over the account's data store (lib/agent-chat.ts runs
// the conversations; this lists them and binds the store once signed in).
import { useEffect } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useAuth } from '../lib/auth'
import { useAgentChat } from '../lib/agent-chat'
import { useStore } from '../lib/store'

export function useConversations() {
  const { store, ready } = useStore()
  return useQuery({ queryKey: ['agent_conversations', store.kind], enabled: ready, queryFn: () => store.listConversations() })
}

/** Mount once below the login gate. */
export function useAgentChatRunner() {
  const qc = useQueryClient()
  const { store, ready } = useStore()
  const userId = useAuth((s) => s.user?.id)
  useEffect(() => {
    if (!ready || !userId) return
    useAgentChat.getState().bind(userId, { store, onSaved: () => qc.invalidateQueries({ queryKey: ['agent_conversations'] }) })
  }, [ready, userId, store, qc])
}
