// Account-level routes — available whether or not Landed Cloud sync is on.
//
//   GET/PATCH /me        profile (onboarding flag, auto_apply_updates, email_watch) + cloud_sync state
//   GET/POST /recovery-codes status / replace the account's offline recovery codes
//   POST /cloud/enable   upload this device's snapshot and turn sync on, atomically
//                        (held agent observations become Cloud data)
//   POST /cloud/disable  { password } — delete every data row and turn sync off;
//                        the account stays (the client has already saved the
//                        data to the device via GET /export)
//   DELETE /me           { password } — delete the account and everything in it
import { parseAutomations } from '@landed/schema/automation'
import { Hono } from 'hono'
import { deleteCookie } from 'hono/cookie'
import { SESSION_COOKIE, verifyPassword, type AppEnv } from '../auth.ts'
import type { Sql } from '../db.ts'
import { fail, jsonBody } from '../http.ts'
import { generateRecoveryCodes, hashRecoveryCode, normalizeRecoveryCode } from '../recovery-codes.ts'
import { uploadSnapshot } from './sync.ts'

const ME_COLUMNS = ['id', 'email', 'cloud_sync', 'onboarded_at', 'auto_apply_updates', 'email_watch', 'email_checked_at', 'automations', 'plan', 'created_at']

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
      select ${sql(ME_COLUMNS)} from users where id = ${c.get('user').id}`
    return c.json(row)
  })

  app.patch('/me', async (c) => {
    const body = await jsonBody(c)
    const patch: Record<string, unknown> = {}
    if ('onboarded_at' in body) {
      const at = body.onboarded_at
      if (at !== null && typeof at !== 'string') fail(400, 'onboarded_at must be an ISO timestamp or null')
      patch.onboarded_at = at
    }
    if ('auto_apply_updates' in body) {
      if (typeof body.auto_apply_updates !== 'boolean') fail(400, 'auto_apply_updates must be a boolean')
      patch.auto_apply_updates = body.auto_apply_updates
    }
    if ('email_watch' in body) {
      if (typeof body.email_watch !== 'boolean') fail(400, 'email_watch must be a boolean')
      patch.email_watch = body.email_watch
    }
    if ('email_checked_at' in body) {
      const at = body.email_checked_at
      if (at !== null && (typeof at !== 'string' || Number.isNaN(Date.parse(at)))) fail(400, 'email_checked_at must be an ISO timestamp or null')
      patch.email_checked_at = at
    }
    if ('automations' in body) {
      if (!body.automations || typeof body.automations !== 'object') fail(400, 'automations must be an object')
      patch.automations = sql.json(parseAutomations(body.automations))
    }
    if (Object.keys(patch).length === 0) {
      fail(400, 'nothing to update (allowed: onboarded_at, auto_apply_updates, email_watch, email_checked_at, automations)')
    }
    const [row] = await sql`
      update users set ${sql(patch)} where id = ${c.get('user').id}
      returning ${sql(ME_COLUMNS)}`
    return c.json(row)
  })

  app.get('/recovery-codes', async (c) => {
    const [row] = await sql<{ remaining: number; created_at: string | null }[]>`
      select count(*)::int as remaining, min(created_at) as created_at
      from account_recovery_codes where user_id = ${c.get('user').id}`
    return c.json({
      remaining: Number(row.remaining),
      created_at: row.created_at ? new Date(row.created_at).toISOString() : null,
    })
  })

  app.post('/recovery-codes', async (c) => {
    const userId = c.get('user').id
    await checkPassword(sql, userId, (await jsonBody(c)).password)
    const codes = generateRecoveryCodes()
    const createdAt = new Date()
    await sql.begin(async (tx) => {
      await tx`delete from account_recovery_codes where user_id = ${userId}`
      for (const code of codes) {
        const normalized = normalizeRecoveryCode(code)!
        await tx`
          insert into account_recovery_codes (code_hash, user_id, created_at)
          values (${hashRecoveryCode(normalized)}, ${userId}, ${createdAt})`
      }
    })
    c.header('Cache-Control', 'no-store')
    return c.json({ codes, created_at: createdAt.toISOString() })
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
      await tx`delete from job_leads where user_id = ${userId}`
      await tx`delete from status_suggestions where user_id = ${userId}`
      await tx`delete from job_searches where user_id = ${userId}`
      await tx`delete from agent_conversations where user_id = ${userId}`
      await tx`delete from application_answers where user_id = ${userId}`
      await tx`delete from application_files where user_id = ${userId}`
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
