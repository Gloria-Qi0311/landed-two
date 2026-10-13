// The Agent page's conversation. Lives in a store (not a component) so leaving
// the panel doesn't cut off a reply that's still streaming. The transcript
// is kept per account in sessionStorage — the conversation itself lives
// with the agent on the user's computer (Claude Code session = conversation id).
import { create } from 'zustand'
import { runOnComputer } from '../hooks/runtimes'

export type Turn = {
  role: 'user' | 'agent'
  text: string
  tools?: string[]
  error?: boolean
  pending?: boolean
}

type ChatState = {
  userId: string | null
  conversationId: string
  turns: Turn[]
  /** Switch to this account's saved transcript (call when the user changes). */
  load: (userId: string) => void
  send: (runtimeId: string, agentId: string, message: string) => Promise<void>
  newChat: () => void
}

const key = (userId: string) => `landed:agent-chat:${userId}`

function restore(userId: string): { conversationId: string; turns: Turn[] } {
  try {
    const saved = JSON.parse(sessionStorage.getItem(key(userId)) ?? 'null')
    if (saved && typeof saved.conversationId === 'string' && Array.isArray(saved.turns)) {
      // A reply that was streaming when the page reloaded won't finish here.
      const turns = (saved.turns as Turn[]).map((t) => (t.pending ? { ...t, pending: false, text: t.text || '(interrupted)' } : t))
      return { conversationId: saved.conversationId, turns }
    }
  } catch {
    // ignore unreadable storage
  }
  return { conversationId: crypto.randomUUID(), turns: [] }
}

export const useAgentChat = create<ChatState>((set, get) => ({
  userId: null,
  conversationId: crypto.randomUUID(),
  turns: [],

  load(userId) {
    if (get().userId === userId) return
    set({ userId, ...restore(userId) })
  },

  async send(runtimeId, agentId, message) {
    const text = message.trim()
    if (!text || get().turns.some((t) => t.pending)) return
    set((s) => ({ turns: [...s.turns, { role: 'user', text }, { role: 'agent', text: '', pending: true }] }))
    const update = (fn: (t: Turn) => Turn) =>
      set((s) => ({ turns: s.turns.map((t, i) => (i === s.turns.length - 1 ? fn(t) : t)) }))
    await runOnComputer(runtimeId, agentId, 'chat', { conversation_id: get().conversationId, message: text }, (e) => {
      if (e.type === 'delta') update((t) => ({ ...t, text: t.text + e.text }))
      if (e.type === 'tool') update((t) => ({ ...t, tools: [...(t.tools ?? []), e.name] }))
      if (e.type === 'done') update((t) => ({ ...t, text: e.text || t.text, pending: false }))
      if (e.type === 'error') update((t) => ({ ...t, text: e.message, error: true, pending: false }))
    })
  },

  newChat() {
    set({ conversationId: crypto.randomUUID(), turns: [] })
  },
}))

useAgentChat.subscribe((s) => {
  if (!s.userId) return
  try {
    sessionStorage.setItem(key(s.userId), JSON.stringify({ conversationId: s.conversationId, turns: s.turns }))
  } catch {
    // storage full or blocked — the transcript just won't survive a reload
  }
})
