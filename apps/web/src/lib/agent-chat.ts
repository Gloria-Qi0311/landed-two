// The Agent page's conversations. Each one is saved in the account's data
// store after every turn (local-first: this browser, or Landed Cloud with
// sync on), so the page can list past chats and pick any of them back up.
// A conversation's id is its Claude Code session id on the user's computer;
// each message also carries the recent turns, for a computer that doesn't
// have that session (packages/schema/src/conversation.ts).
//
// Live state (a reply still streaming) lives here, not in a component, so
// switching chats or pages doesn't cut it off.
import { create } from 'zustand'
import { titleFrom, type ChatTurn } from '@landed/schema/conversation'
import type { DataStore, DbConversation } from './store/types'
import type { Attachment } from './chat-images'
import { runOnComputer } from '../hooks/runtimes'

export type Turn = ChatTurn & { pending?: boolean }

type Binding = { store: DataStore; onSaved: () => void }

type ChatState = {
  userId: string | null
  /** the open conversation; null = a new chat that hasn't started yet */
  activeId: string | null
  /** turns of conversations touched this session (incl. a streaming reply) */
  live: Record<string, { title: string; turns: Turn[]; created_at?: string }>
  bind: (userId: string, binding: Binding) => void
  open: (conv: DbConversation) => void
  newChat: () => void
  send: (runtimeId: string, agentId: string, message: string, saved?: DbConversation, images?: Attachment[]) => Promise<void>
}

let binding: Binding | null = null

/** Before chat history: the transcript lived in this tab only. Save it once. */
const legacyKey = (userId: string) => `landed:agent-chat:${userId}`
async function migrateLegacy(userId: string, store: DataStore) {
  try {
    const raw = JSON.parse(sessionStorage.getItem(legacyKey(userId)) ?? 'null')
    sessionStorage.removeItem(legacyKey(userId))
    const turns = (Array.isArray(raw?.turns) ? raw.turns : []).filter((t: Turn) => !t.pending && t.text)
    if (typeof raw?.conversationId === 'string' && turns.length) {
      await store.saveConversation({ id: raw.conversationId, title: titleFrom(turns.find((t: Turn) => t.role === 'user')?.text ?? ''), turns })
      return true
    }
  } catch {
    // nothing to migrate
  }
  return false
}

const persistable = (turns: Turn[]): ChatTurn[] => turns.filter((t) => !t.pending).map(({ pending: _p, ...t }) => t)

export const useAgentChat = create<ChatState>((set, get) => {
  async function persist(id: string) {
    const conv = get().live[id]
    if (!binding || !conv) return
    try {
      await binding.store.saveConversation({ id, title: conv.title, turns: persistable(conv.turns), created_at: conv.created_at })
      binding.onSaved()
    } catch (e) {
      console.warn('[landed] saving the conversation failed', e)
    }
  }

  return {
    userId: null,
    activeId: null,
    live: {},

    bind(userId, next) {
      binding = next
      if (get().userId === userId) return
      set({ userId, activeId: null, live: {} })
      void migrateLegacy(userId, next.store).then((moved) => moved && next.onSaved())
    },

    open(conv) {
      set((s) => ({
        activeId: conv.id,
        // Keep what's live (a reply may still be streaming); otherwise load the saved turns.
        live: s.live[conv.id] ? s.live : { ...s.live, [conv.id]: { title: conv.title, turns: conv.turns, created_at: conv.created_at } },
      }))
    },

    newChat() {
      set({ activeId: null })
    },

    async send(runtimeId, agentId, message, saved, images = []) {
      const text = message.trim()
      if (!text && images.length === 0) return
      const id = get().activeId ?? crypto.randomUUID()
      const before = get().live[id] ?? (saved ? { title: saved.title, turns: saved.turns, created_at: saved.created_at } : null)
      if (before?.turns.some((t) => t.pending)) return
      const history = persistable(before?.turns ?? [])
      set((s) => ({
        activeId: id,
        live: {
          ...s.live,
          [id]: {
            title: before?.title ?? titleFrom(text || 'Screenshot'),
            created_at: before?.created_at,
            turns: [
              ...(before?.turns ?? []),
              // The conversation keeps small previews; the images go to the agent once.
              { role: 'user', text, ...(images.length ? { images: images.map(({ name, thumb }) => ({ name, thumb })) } : {}) },
              { role: 'agent', text: '', pending: true },
            ],
          },
        },
      }))
      void persist(id) // the question is saved even if the reply never comes

      const update = (fn: (t: Turn) => Turn) =>
        set((s) => {
          const conv = s.live[id]
          if (!conv) return s
          return { live: { ...s.live, [id]: { ...conv, turns: conv.turns.map((t, i) => (i === conv.turns.length - 1 ? fn(t) : t)) } } }
        })
      const sent = images.map(({ type, data_base64 }) => ({ type, data_base64 }))
      await runOnComputer(runtimeId, agentId, 'chat', { conversation_id: id, message: text, history, ...(sent.length ? { images: sent } : {}) }, (e) => {
        if (e.type === 'delta') update((t) => ({ ...t, text: t.text + e.text }))
        if (e.type === 'tool') update((t) => ({ ...t, tools: [...(t.tools ?? []), e.name] }))
        if (e.type === 'done') {
          update((t) => ({ ...t, text: e.text || t.text, pending: false }))
          void persist(id)
        }
        if (e.type === 'error') {
          update((t) => ({ ...t, text: e.message, error: true, pending: false }))
          void persist(id)
        }
      })
    },
  }
})

/** Rename a conversation (saved right away). */
export async function renameConversation(conv: DbConversation, title: string) {
  if (!binding) return
  const live = useAgentChat.getState().live[conv.id]
  const next = title.trim().slice(0, 120) || conv.title
  if (live) useAgentChat.setState((s) => ({ live: { ...s.live, [conv.id]: { ...live, title: next } } }))
  await binding.store.saveConversation({ id: conv.id, title: next, turns: persistable(live?.turns ?? conv.turns), created_at: conv.created_at })
  binding.onSaved()
}

export async function deleteConversation(id: string) {
  if (!binding) return
  await binding.store.deleteConversation(id)
  useAgentChat.setState((s) => {
    const { [id]: _gone, ...live } = s.live
    return { live, activeId: s.activeId === id ? null : s.activeId }
  })
  binding.onSaved()
}
