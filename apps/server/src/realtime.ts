// Realtime for portal_events (replaces Supabase Realtime postgres_changes).
//
// The portal_events_notify trigger pg_notify()s {id, user_id} on every
// insert — whichever code path inserted it. One LISTEN connection here fans
// each notification out to that user's open SSE streams only, re-reading
// the row so subscribers get the full payload.
import type { Sql } from './db.ts'

type Listener = (row: Record<string, unknown>) => void

export class PortalEventsHub {
  private byUser = new Map<string, Set<Listener>>()
  private unlisten: (() => Promise<void>) | null = null
  private sql: Sql

  constructor(sql: Sql) {
    this.sql = sql
  }

  async start() {
    const { unlisten } = await this.sql.listen('portal_events', (payload) => {
      void this.dispatch(payload)
    })
    this.unlisten = unlisten
  }

  async stop() {
    await this.unlisten?.()
  }

  subscribe(userId: string, listener: Listener): () => void {
    let set = this.byUser.get(userId)
    if (!set) this.byUser.set(userId, (set = new Set()))
    set.add(listener)
    return () => {
      set.delete(listener)
      if (set.size === 0) this.byUser.delete(userId)
    }
  }

  private async dispatch(payload: string) {
    let msg: { id: string; user_id: string }
    try {
      msg = JSON.parse(payload)
    } catch {
      return
    }
    const listeners = this.byUser.get(msg.user_id)
    if (!listeners?.size) return
    const [row] = await this.sql`
      select * from portal_events where id = ${msg.id} and user_id = ${msg.user_id}`
    if (!row) return
    for (const l of listeners) l(row)
  }
}
