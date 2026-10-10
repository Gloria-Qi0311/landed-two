// Account-level routes — available whether or not Landed Cloud sync is on.
//
//   GET/PATCH /me        profile (onboarding flag) + cloud_sync state
//   POST /cloud/enable   upload this device's snapshot and turn sync on, atomically
//                        (held agent observations become Cloud data)
//   POST /cloud/disable  { password } — delete every data row and turn sync off;
//                        the account stays (the client has already saved the
//                        data to the device via GET /export)
//   DELETE /me           { password } — delete the account and everything in it
import { Hono } from 'hono'
import { deleteCookie } from 'hono/cookie'
import { SESSION_COOKIE, verifyPassword, type AppEnv } from '../auth.ts'
import type { Sql } from '../db.ts'
import { fail, jsonBody } from '../http.ts'
import { uploadSnapshot } from './sync.ts'

async function checkPassword(sql: Sql, userId: string, password: unknown) {
  const [row] = await sql<{ password_hash: string }[]>`select password_hash from users where id = ${userId}`
  if (typeof password !== 'string' || !(await verifyPassword(password, row.password_hash))) {
    fail(403, 'wrong password')
  }
}

export function accountRoutes(sql: Sql) {
  const app = new Hono<AppEnv>()

  app.get('/me', async (c) => {
    const [row] = await sql`
      select id, email, cloud_sync, onboarded_at, plan, created_at from users where id = ${c.get('user').id}`
    return c.json(row)
  })

  app.patch('/me', async (c) => {
    const body = await jsonBody(c)
    if (!('onboarded_at' in body)) fail(400, 'nothing to update (allowed: onboarded_at)')
    const at = body.onboarded_at
    if (at !== null && typeof at !== 'string') fail(400, 'onboarded_at must be an ISO timestamp or null')
    const [row] = await sql`
      update users set onboarded_at = ${at} where id = ${c.get('user').id}
      returning id, email, cloud_sync, onboarded_at, plan, created_at`
    return c.json(row)
  })

  app.post('/cloud/enable', async (c) => {
    const userId = c.get('user').id
    const snap = await jsonBody(c)
    const uploaded = await sql.begin(async (txRaw) => {
      const tx = txRaw as unknown as Sql
      const counts = await uploadSnapshot(tx, userId, snap)
      // Agent observations still held for pickup become ordinary Cloud data.
      await tx`update agent_observations set expires_at = null where user_id = ${userId} and payload_json is not null`
      await tx`update users set cloud_sync = true where id = ${userId}`
      return counts
    })
    return c.json({ cloud_sync: true, uploaded })
  })

  app.post('/cloud/disable', async (c) => {
    const userId = c.get('user').id
    await checkPassword(sql, userId, (await jsonBody(c)).password)
    await sql.begin(async (tx) => {
      // companies cascade to applications, connections and their events
      await tx`delete from companies where user_id = ${userId}`
      await tx`delete from portal_events where user_id = ${userId}`
      await tx`delete from resumes where user_id = ${userId}`
      await tx`delete from ai_runs where user_id = ${userId}`
      await tx`delete from ai_provider_keys where user_id = ${userId}`
      // Observations moved to the device with the export; keep payload-free
      // receipts so agent retries stay idempotent.
      await tx`update agent_observations set payload_json = null, delivered_at = now(), expires_at = null
               where user_id = ${userId} and payload_json is not null`
      await tx`update users set cloud_sync = false where id = ${userId}`
    })
    return c.json({ cloud_sync: false })
  })

  app.delete('/me', async (c) => {
    const userId = c.get('user').id
    await checkPassword(sql, userId, (await jsonBody(c)).password)
    await sql`delete from users where id = ${userId}`
    deleteCookie(c, SESSION_COOKIE, { path: '/' })
    return c.body(null, 204)
  })

  return app
}
