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
  /** screenshots the user attached, as small previews (the full images go
   *  to the agent once, with the message, and aren't kept) */
  images?: { name: string; thumb: string }[]
}

/** An image attached to a chat message, as the task carries it. */
export type ChatImage = { type: string; data_base64: string }

export const MAX_CHAT_IMAGES = 4
export const CHAT_IMAGE_TYPES = ['image/png', 'image/jpeg', 'image/webp', 'image/gif']
const MAX_IMAGE_B64 = 4_000_000 // ≈ 3 MB each
const MAX_IMAGES_B64 = 8_000_000
const MAX_THUMB = 40_000

/** Validate a chat task's images: known types, base64, bounded in count and size. */
export function parseChatImages(raw: unknown): ChatImage[] {
  if (!Array.isArray(raw)) return []
  const out: ChatImage[] = []
  let total = 0
  for (const img of raw.slice(0, MAX_CHAT_IMAGES)) {
    if (!img || typeof img !== 'object') continue
    const r = img as Record<string, unknown>
    if (typeof r.type !== 'string' || !CHAT_IMAGE_TYPES.includes(r.type)) continue
    if (typeof r.data_base64 !== 'string' || !r.data_base64 || r.data_base64.length > MAX_IMAGE_B64 || !/^[A-Za-z0-9+/]+={0,2}$/.test(r.data_base64)) continue
    total += r.data_base64.length
    if (total > MAX_IMAGES_B64) break
    out.push({ type: r.type, data_base64: r.data_base64 })
  }
  return out
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
  if (Array.isArray(r.images)) {
    const images = r.images.slice(0, MAX_CHAT_IMAGES)
      .filter((i): i is Record<string, unknown> => !!i && typeof i === 'object')
      .filter((i) => typeof i.thumb === 'string' && i.thumb.length <= MAX_THUMB && /^data:image\/(jpeg|png|webp);base64,[A-Za-z0-9+/]+={0,2}$/.test(i.thumb))
      .map((i) => ({ name: typeof i.name === 'string' ? i.name.slice(0, 120) : 'image', thumb: i.thumb as string }))
    if (images.length) out.images = images
  }
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
  const turns = raw.map((t) => turn(t, 8_000))
    .filter((t): t is ChatTurn => !!t && !t.error && (!!t.text.trim() || !!t.images?.length))
    .map((t) => (t.images?.length ? { ...t, text: `${t.text}${t.text ? '\n' : ''}[attached ${t.images.length === 1 ? 'a screenshot' : `${t.images.length} screenshots`}]` } : t))
    .slice(-HISTORY_TURNS)
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

// ── what Landed knows about the user, for the chat agent ──────────────────
// The master resume's gist (education, jobs, skills, where they are), the
// saved answers that shape a search (work authorization, sponsorship,
// places, start date) and the active search: so the agent proposes a
// direction from what it already knows instead of asking for the resume.
// Plain text, built in the browser (apps/web/src/lib/chat-context.ts);
// never contact details, address, date of birth or EEO answers. It goes to
// the user's own agent, like resume parsing and tailoring.

export const MAX_CHAT_CONTEXT = 8_000

export function parseChatContext(raw: unknown): string | null {
  if (typeof raw !== 'string') return null
  const t = raw.replace(/\r\n?/g, '\n').replace(/\n{3,}/g, '\n\n').trim()
  return t ? t.slice(0, MAX_CHAT_CONTEXT) : null
}
