// Email + password auth (replaces Supabase Auth).
//
// Sessions are opaque random tokens; the DB stores only their SHA-256. Two
// delivery modes share the same table:
//   - 'cookie': the web app. httpOnly + SameSite=Lax cookie, so page JS
//     never sees the token and cross-site forms can't ride it.
//   - 'token':  the browser extension. Returned once in the login response
//     and sent back as `Authorization: Bearer <token>`.
// Both slide: each use pushes expires_at out to SESSION_TTL from now
// (at most once a day, to avoid a write per request).
import { createHash, randomBytes, scrypt as scryptCb, timingSafeEqual, type ScryptOptions } from 'node:crypto'
import { Hono, type Context, type MiddlewareHandler } from 'hono'
import { deleteCookie, getCookie, setCookie } from 'hono/cookie'
import type { Config } from './config.ts'
import type { Sql } from './db.ts'
import type { PasswordResetSender } from './email.ts'
import { fail, jsonBody } from './http.ts'
import { hashRecoveryCode, normalizeRecoveryCode } from './recovery-codes.ts'

export type SessionUser = { id: string; email: string; cloud_sync: boolean }
export type AppEnv = { Variables: { user: SessionUser; sessionHash: string } }

export const SESSION_COOKIE = 'landed_session'
const SESSION_TTL_DAYS = 60
const SESSION_TTL_MS = SESSION_TTL_DAYS * 86_400_000
const RESET_TTL_MINUTES = 30
const RESET_TTL_MS = RESET_TTL_MINUTES * 60_000

// ── password hashing (scrypt, no native deps) ─────────────────────────────

const SCRYPT = { N: 1 << 15, r: 8, p: 1, keylen: 64 }

function scrypt(password: string, salt: Buffer, keylen: number, opts: ScryptOptions): Promise<Buffer> {
  return new Promise((resolve, reject) =>
    scryptCb(password, salt, keylen, opts, (err, key) => (err ? reject(err) : resolve(key))),
  )
}

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16)
  const { N, r, p, keylen } = SCRYPT
  const key = await scrypt(password, salt, keylen, { N, r, p, maxmem: 128 * N * r * 2 })
  return `scrypt$${N}$${r}$${p}$${salt.toString('base64')}$${key.toString('base64')}`
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const [algo, n, r, p, saltB64, keyB64] = stored.split('$')
  if (algo !== 'scrypt') return false
  const expected = Buffer.from(keyB64, 'base64')
  const N = Number(n), R = Number(r), P = Number(p)
  const key = await scrypt(password, Buffer.from(saltB64, 'base64'), expected.length, {
    N, r: R, p: P, maxmem: 128 * N * R * 2,
  })
  return timingSafeEqual(key, expected)
}

// Verified against when the email doesn't exist, so "no such user" and
// "wrong password" take the same time.
const DUMMY_HASH = await hashPassword(randomBytes(16).toString('hex'))

// ── sessions ──────────────────────────────────────────────────────────────

const sha256 = (s: string) => createHash('sha256').update(s).digest('hex')

async function createSession(sql: Sql, userId: string, kind: 'cookie' | 'token', userAgent: string | undefined) {
  const token = randomBytes(32).toString('base64url')
  await sql`
    insert into sessions (token_hash, user_id, kind, user_agent, expires_at)
    values (${sha256(token)}, ${userId}, ${kind}, ${userAgent?.slice(0, 512) ?? null},
            ${new Date(Date.now() + SESSION_TTL_MS)})`
  return token
}

function readToken(c: Context): string | null {
  const header = c.req.header('Authorization')
  if (header?.toLowerCase().startsWith('bearer ')) return header.slice(7).trim() || null
  return getCookie(c, SESSION_COOKIE) ?? null
}

export function requireUser(sql: Sql): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    const token = readToken(c)
    if (!token) fail(401, 'not signed in')
    const hash = sha256(token)
    const [row] = await sql<(SessionUser & { expires_at: string; last_used_at: string })[]>`
      select u.id, u.email, u.cloud_sync, s.expires_at, s.last_used_at
      from sessions s join users u on u.id = s.user_id
      where s.token_hash = ${hash}`
    if (!row || Date.parse(row.expires_at) < Date.now()) {
      if (row) await sql`delete from sessions where token_hash = ${hash}`
      fail(401, 'session expired — sign in again')
    }
    if (Date.now() - Date.parse(row.last_used_at) > 86_400_000) {
      await sql`
        update sessions set last_used_at = now(), expires_at = ${new Date(Date.now() + SESSION_TTL_MS)}
        where token_hash = ${hash}`
    }
    c.set('user', { id: row.id, email: row.email, cloud_sync: row.cloud_sync })
    c.set('sessionHash', hash)
    await next()
  }
}

// ── login rate limit (in-memory; single server process) ──────────────────
// 10 failed attempts per (ip) or per (email) per 15 minutes.

const WINDOW_MS = 15 * 60_000
const MAX_FAILURES = 10
const failures = new Map<string, number[]>()
const resetRequests = new Map<string, number[]>()
const resetAttempts = new Map<string, number[]>()

function recentFailures(key: string): number[] {
  const cutoff = Date.now() - WINDOW_MS
  const list = (failures.get(key) ?? []).filter((t) => t > cutoff)
  if (list.length) failures.set(key, list)
  else failures.delete(key)
  return list
}

function clientIp(c: Context): string {
  // Behind Cloudflare Tunnel the origin only ever sees cloudflared on
  // localhost, so the CF header is the real client.
  return c.req.header('CF-Connecting-IP') ?? c.req.header('X-Forwarded-For')?.split(',')[0]?.trim() ?? 'local'
}

function tooManyResetRequests(key: string): boolean {
  const cutoff = Date.now() - 60 * 60_000
  const hits = (resetRequests.get(key) ?? []).filter((time) => time > cutoff)
  hits.push(Date.now())
  resetRequests.set(key, hits)
  return hits.length > 5
}

function tooManyResetAttempts(key: string): boolean {
  const cutoff = Date.now() - WINDOW_MS
  const hits = (resetAttempts.get(key) ?? []).filter((time) => time > cutoff)
  hits.push(Date.now())
  resetAttempts.set(key, hits)
  return hits.length > 20
}

function publicOrigin(c: Context, config: Pick<Config, 'publicUrl'>): string {
  if (config.publicUrl) return config.publicUrl
  const url = new URL(c.req.url)
  const proto = c.req.header('x-forwarded-proto')?.split(',')[0].trim() || url.protocol.replace(':', '')
  const host = c.req.header('x-forwarded-host')?.split(',')[0].trim() || c.req.header('host') || url.host
  return `${proto}://${host}`
}

// ── routes ────────────────────────────────────────────────────────────────

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

function credentials(body: Record<string, unknown>) {
  const email = typeof body.email === 'string' ? body.email.trim().toLowerCase() : ''
  const password = typeof body.password === 'string' ? body.password : ''
  const mode = body.mode === 'token' ? 'token' : 'cookie'
  if (!EMAIL_RE.test(email) || email.length > 320) fail(400, 'enter a valid email address')
  if (password.length > 1024) fail(400, 'password too long')
  return { email, password, mode } as const
}

export function authRoutes(sql: Sql, config: Config, sendPasswordReset: PasswordResetSender | null = null) {
  const app = new Hono<AppEnv>()

  async function startSession(c: Context, user: SessionUser, mode: 'cookie' | 'token') {
    const token = await createSession(sql, user.id, mode, c.req.header('User-Agent'))
    if (mode === 'token') return c.json({ user, token })
    setCookie(c, SESSION_COOKIE, token, {
      httpOnly: true,
      sameSite: 'Lax',
      secure: config.cookieSecure,
      path: '/',
      maxAge: SESSION_TTL_DAYS * 86_400,
    })
    return c.json({ user })
  }

  app.post('/signup', async (c) => {
    const { email, password, mode } = credentials(await jsonBody(c))
    if (password.length < 8) fail(400, 'password must be at least 8 characters')
    const passwordHash = await hashPassword(password)
    const user = await sql.begin(async (tx) => {
      // Serialize signups so 'first-only' can't be raced by two requests.
      await tx`select pg_advisory_xact_lock(hashtext('landed:signup'))`
      if (config.signup === 'first-only') {
        const [{ any }] = await tx<{ any: boolean }[]>`select exists (select 1 from users) as any`
        if (any) fail(403, 'sign-ups are closed on this server')
      }
      const [row] = await tx<SessionUser[]>`
        insert into users (email, password_hash) values (${email}, ${passwordHash})
        on conflict (email) do nothing
        returning id, email, cloud_sync`
      if (!row) fail(409, 'an account with this email already exists — sign in instead')
      return row
    })
    c.status(201)
    return startSession(c, user, mode)
  })

  app.post('/login', async (c) => {
    const { email, password, mode } = credentials(await jsonBody(c))
    const keys = ['ip:' + clientIp(c), 'email:' + email]
    if (keys.some((k) => recentFailures(k).length >= MAX_FAILURES)) {
      fail(429, 'too many failed attempts — try again in 15 minutes')
    }
    const [row] = await sql<(SessionUser & { password_hash: string })[]>`
      select id, email, cloud_sync, password_hash from users where email = ${email}`
    const ok = await verifyPassword(password, row?.password_hash ?? DUMMY_HASH)
    if (!row || !ok) {
      for (const k of keys) failures.set(k, [...recentFailures(k), Date.now()])
      fail(401, 'wrong email or password')
    }
    for (const k of keys) failures.delete(k)
    return startSession(c, { id: row.id, email: row.email, cloud_sync: row.cloud_sync }, mode)
  })

  app.post('/forgot-password', async (c) => {
    if (!sendPasswordReset) fail(503, 'password recovery is not configured on this server')
    const { email } = credentials(await jsonBody(c))
    const keys = ['ip:' + clientIp(c), 'email:' + email]
    if (keys.some(tooManyResetRequests)) fail(429, 'too many reset requests — try again later')

    const [user] = await sql<{ id: string }[]>`select id from users where email = ${email}`
    if (user) {
      const rawToken = randomBytes(32).toString('base64url')
      const tokenHash = sha256(rawToken)
      await sql.begin(async (tx) => {
        await tx`delete from password_reset_tokens where user_id = ${user.id}`
        await tx`
          insert into password_reset_tokens (token_hash, user_id, expires_at)
          values (${tokenHash}, ${user.id}, ${new Date(Date.now() + RESET_TTL_MS)})`
      })
      const resetUrl = `${publicOrigin(c, config)}/reset-password#token=${encodeURIComponent(rawToken)}`
      try {
        await sendPasswordReset({ to: email, resetUrl, expiresInMinutes: RESET_TTL_MINUTES })
      } catch (error) {
        await sql`delete from password_reset_tokens where token_hash = ${tokenHash}`
        console.error('[auth] password reset email failed:', error instanceof Error ? error.message : 'unknown error')
      }
    }
    c.header('Cache-Control', 'no-store')
    return c.json({ message: 'If that email has a Landed account, a reset link is on its way.' }, 202)
  })

  app.post('/reset-password', async (c) => {
    if (tooManyResetAttempts('ip:' + clientIp(c))) fail(429, 'too many reset attempts — try again in 15 minutes')
    const body = await jsonBody(c)
    const rawToken = typeof body.token === 'string' ? body.token : ''
    const password = typeof body.password === 'string' ? body.password : ''
    if (!/^[A-Za-z0-9_-]{40,100}$/.test(rawToken)) fail(400, 'reset link is invalid or has expired')
    if (password.length < 8) fail(400, 'password must be at least 8 characters')
    if (password.length > 1024) fail(400, 'password too long')
    const passwordHash = await hashPassword(password)
    const resetHash = sha256(rawToken)
    const user = await sql.begin(async (tx) => {
      const [row] = await tx<SessionUser[]>`
        select u.id, u.email, u.cloud_sync
        from password_reset_tokens r join users u on u.id = r.user_id
        where r.token_hash = ${resetHash} and r.expires_at > now()
        for update of r`
      if (!row) fail(400, 'reset link is invalid or has expired')
      await tx`update users set password_hash = ${passwordHash} where id = ${row.id}`
      await tx`delete from sessions where user_id = ${row.id}`
      await tx`delete from password_reset_tokens where user_id = ${row.id}`
      return row
    })
    c.header('Cache-Control', 'no-store')
    return startSession(c, user, 'cookie')
  })

  app.post('/recover-with-code', async (c) => {
    const body = await jsonBody(c)
    const { email, password } = credentials(body)
    const normalizedCode = normalizeRecoveryCode(body.code)
    const rateKeys = ['ip:' + clientIp(c), 'email:' + email]
    if (rateKeys.some(tooManyResetAttempts)) fail(429, 'too many recovery attempts — try again in 15 minutes')
    if (!normalizedCode) fail(400, 'recovery code is invalid or has already been used')
    if (password.length < 8) fail(400, 'password must be at least 8 characters')
    const passwordHash = await hashPassword(password)
    const codeHash = hashRecoveryCode(normalizedCode)
    const user = await sql.begin(async (tx) => {
      const [row] = await tx<SessionUser[]>`
        select u.id, u.email, u.cloud_sync
        from account_recovery_codes r join users u on u.id = r.user_id
        where r.code_hash = ${codeHash} and u.email = ${email}
        for update of r`
      if (!row) fail(400, 'recovery code is invalid or has already been used')
      await tx`update users set password_hash = ${passwordHash} where id = ${row.id}`
      await tx`delete from sessions where user_id = ${row.id}`
      await tx`delete from password_reset_tokens where user_id = ${row.id}`
      await tx`delete from account_recovery_codes where code_hash = ${codeHash}`
      return row
    })
    c.header('Cache-Control', 'no-store')
    return startSession(c, user, 'cookie')
  })

  app.post('/logout', async (c) => {
    const token = readToken(c)
    if (token) await sql`delete from sessions where token_hash = ${sha256(token)}`
    deleteCookie(c, SESSION_COOKIE, { path: '/' })
    return c.body(null, 204)
  })

  // Session probe for app start-up. 200 with user: null when signed out, so
  // the signed-out path doesn't log a 401 in the console on every load.
  app.get('/session', async (c) => {
    const token = readToken(c)
    if (!token) return c.json({ user: null })
    const [row] = await sql<SessionUser[]>`
      select u.id, u.email, u.cloud_sync from sessions s join users u on u.id = s.user_id
      where s.token_hash = ${sha256(token)} and s.expires_at > now()`
    return c.json({ user: row ?? null })
  })

  return app
}

/** Data routes only work for accounts that turned on Landed Cloud sync. */
export const requireCloud: MiddlewareHandler<AppEnv> = async (c, next) => {
  if (!c.get('user').cloud_sync) {
    fail(409, 'Landed Cloud sync is off for this account — its data lives on your devices', { code: 'cloud_off' })
  }
  await next()
}

export async function deleteExpiredSessions(sql: Sql) {
  await sql`delete from sessions where expires_at < now()`
  await sql`delete from password_reset_tokens where expires_at < now()`
}
