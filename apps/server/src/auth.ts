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
import { fail, jsonBody } from './http.ts'

export type SessionUser = { id: string; email: string }
export type AppEnv = { Variables: { user: SessionUser; sessionHash: string } }

export const SESSION_COOKIE = 'landed_session'
const SESSION_TTL_DAYS = 60
const SESSION_TTL_MS = SESSION_TTL_DAYS * 86_400_000

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
    const [row] = await sql<{ id: string; email: string; expires_at: string; last_used_at: string }[]>`
      select u.id, u.email, s.expires_at, s.last_used_at
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
    c.set('user', { id: row.id, email: row.email })
    c.set('sessionHash', hash)
    await next()
  }
}

// ── login rate limit (in-memory; single server process) ──────────────────
// 10 failed attempts per (ip) or per (email) per 15 minutes.

const WINDOW_MS = 15 * 60_000
const MAX_FAILURES = 10
const failures = new Map<string, number[]>()

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

export function authRoutes(sql: Sql, config: Config) {
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
        returning id, email`
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
      select id, email, password_hash from users where email = ${email}`
    const ok = await verifyPassword(password, row?.password_hash ?? DUMMY_HASH)
    if (!row || !ok) {
      for (const k of keys) failures.set(k, [...recentFailures(k), Date.now()])
      fail(401, 'wrong email or password')
    }
    for (const k of keys) failures.delete(k)
    return startSession(c, { id: row.id, email: row.email }, mode)
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
      select u.id, u.email from sessions s join users u on u.id = s.user_id
      where s.token_hash = ${sha256(token)} and s.expires_at > now()`
    return c.json({ user: row ?? null })
  })

  return app
}

export async function deleteExpiredSessions(sql: Sql) {
  await sql`delete from sessions where expires_at < now()`
}
