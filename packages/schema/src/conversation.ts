// Agent chat history: conversations on the Agent page, kept in the user's
// data store (local-first like everything else). A conversation's id is also
// its Claude Code session id on the user's computer, so continuing an old
// conversation resumes that session; on a computer that doesn't have it,
// the recent turns are sent along (`history`) so the agent can pick up.
// Plain TS, no dependencies (the server imports it with type stripping).

export type ChatTurn = {
  role: 'user' | 'agent'
  text: string
  /** tools the agent used for this reply (WebSearch, WebFetch…) */
  tools?: string[]
  error?: boolean
}

export type Conversation = {
  id: string
  title: string
  turns: ChatTurn[]
  created_at: string
  updated_at: string
}

export const MAX_TURNS = 400
const MAX_TURN_TEXT = 60_000
export const MAX_TITLE = 120
const HISTORY_TURNS = 24
const HISTORY_CHARS = 40_000

const UUID = /^[0-9a-f-]{36}$/i

function turn(raw: unknown, maxText = MAX_TURN_TEXT): ChatTurn | null {
  if (!raw || typeof raw !== 'object') return null
  const r = raw as Record<string, unknown>
  if (r.role !== 'user' && r.role !== 'agent') return null
  if (typeof r.text !== 'string') return null
  const out: ChatTurn = { role: r.role, text: r.text.slice(0, maxText) }
  if (Array.isArray(r.tools)) {
    const tools = r.tools.filter((t): t is string => typeof t === 'string').map((t) => t.slice(0, 80)).slice(0, 50)
    if (tools.length) out.tools = tools
  }
  if (r.error === true) out.error = true
  return out
}

/** Title from the first thing the user said. */
export function titleFrom(text: string): string {
  const t = text.replace(/\s+/g, ' ').trim()
  return (t.length > 60 ? `${t.slice(0, 57)}…` : t) || 'New chat'
}

/** Validate a conversation from an untrusted source (request body, backup). */
export function parseConversation(raw: unknown): Omit<Conversation, 'created_at' | 'updated_at'> & Partial<Pick<Conversation, 'created_at' | 'updated_at'>> | null {
  if (!raw || typeof raw !== 'object') return null
  const r = raw as Record<string, unknown>
  if (typeof r.id !== 'string' || !UUID.test(r.id)) return null
  const turns = (Array.isArray(r.turns) ? r.turns : []).slice(-MAX_TURNS).map((t) => turn(t)).filter((t): t is ChatTurn => !!t)
  const title = typeof r.title === 'string' && r.title.trim() ? r.title.trim().slice(0, MAX_TITLE) : titleFrom(turns.find((t) => t.role === 'user')?.text ?? '')
  const iso = (v: unknown) => (typeof v === 'string' && !Number.isNaN(Date.parse(v)) ? v : undefined)
  return { id: r.id, title, turns, created_at: iso(r.created_at), updated_at: iso(r.updated_at) }
}

/** What a chat task carries of the earlier conversation: the most recent
 *  turns (errors left out), bounded in count and size. */
export function parseChatHistory(raw: unknown): { role: 'user' | 'agent'; text: string }[] {
  if (!Array.isArray(raw)) return []
  const turns = raw.map((t) => turn(t, 8_000)).filter((t): t is ChatTurn => !!t && !t.error && !!t.text.trim()).slice(-HISTORY_TURNS)
  // Keep the newest turns that fit.
  const out: { role: 'user' | 'agent'; text: string }[] = []
  let size = 0
  for (const t of [...turns].reverse()) {
    size += t.text.length
    if (size > HISTORY_CHARS) break
    out.unshift({ role: t.role, text: t.text })
  }
  return out
}
