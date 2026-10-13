// OAuth 2.1 for cloud agents, so ChatGPT, Claude.ai, Gemini and other MCP
// clients can connect to Landed's MCP server (routes/mcp.ts) with a click:
//
//   1. the client finds us: GET /.well-known/oauth-protected-resource[/mcp]
//      (RFC 9728) → GET /.well-known/oauth-authorization-server (RFC 8414)
//   2. registers itself: POST /oauth/register (RFC 7591; public clients use
//      PKCE alone, confidential ones also get a secret)
//   3. sends the user to /authorize-agent — a page of the web app, so the
//      user signs in as usual and sees who is asking and what it may do;
//      Allow → POST /api/oauth/approve (session) → back to the client with a
//      one-time code (10 minutes, PKCE S256 required)
//   4. swaps the code: POST /oauth/token → access token (7 days) + refresh
//      token (rotated on every use)
//
// Each approval creates an agent connection (agent_connections, provider
// 'mcp'): listed and revoked with the others, and limited to what agent
// connections can do — report observations and read the briefing. Tokens and
// codes are stored as SHA-256 hashes only.
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'
import { Hono, type Context } from 'hono'
import type { AppEnv } from '../auth.ts'
import type { Config } from '../config.ts'
import type { Sql } from '../db.ts'
import { fail, jsonBody } from '../http.ts'

const sha256 = (s: string) => createHash('sha256').update(s).digest('hex')
const token = (prefix: string) => `${prefix}${randomBytes(32).toString('base64url')}`

export const MCP_SCOPES = ['observations:write', 'tasks:read']
export const ACCESS_TTL_S = 7 * 86_400
const CODE_TTL_MS = 10 * 60_000
const MAX_ACTIVE_CONNECTIONS = 20
const MAX_REDIRECT_URIS = 10
const REGISTRATIONS_PER_HOUR = 30
const AUTH_METHODS = ['none', 'client_secret_post', 'client_secret_basic'] as const

/** The origin clients see (PUBLIC_URL, else the request's, honoring the
 *  proxy's X-Forwarded-* headers — Cloudflare Tunnel, Vite in dev). */
export function publicOrigin(c: Context, config: Pick<Config, 'publicUrl'>): string {
  if (config.publicUrl) return config.publicUrl
  const url = new URL(c.req.url)
  const proto = c.req.header('x-forwarded-proto')?.split(',')[0].trim() || url.protocol.replace(':', '')
  const host = c.req.header('x-forwarded-host')?.split(',')[0].trim() || c.req.header('host') || url.host
  return `${proto}://${host}`
}

export function resourceMetadataUrl(origin: string) {
  return `${origin}/.well-known/oauth-protected-resource/mcp`
}

/** https anywhere, or http on this machine (native apps and CLIs listening
 *  on a loopback port, RFC 8252). Nothing else: no custom schemes, no
 *  fragments. */
export function allowedRedirect(raw: unknown): raw is string {
  if (typeof raw !== 'string' || raw.length > 2000) return false
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    return false
  }
  if (url.hash) return false
  if (url.protocol === 'https:') return true
  return url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)
}

const S256 = (verifier: string) => createHash('sha256').update(verifier).digest('base64url')

function sameSecret(given: string, hash: string | null): boolean {
  if (!hash) return false
  const a = Buffer.from(sha256(given), 'hex')
  const b = Buffer.from(hash, 'hex')
  return a.length === b.length && timingSafeEqual(a, b)
}

// RFC 6749 §5.2 error responses (not Landed's usual {error: message}).
function oauthError(c: Context, status: 400 | 401, error: string, description: string) {
  c.header('Cache-Control', 'no-store')
  return c.json({ error, error_description: description }, status)
}

const registrations = new Map<string, number[]>()
function tooManyRegistrations(ip: string): boolean {
  const cutoff = Date.now() - 3_600_000
  const hits = (registrations.get(ip) ?? []).filter((t) => t > cutoff)
  hits.push(Date.now())
  registrations.set(ip, hits)
  return hits.length > REGISTRATIONS_PER_HOUR
}

type Client = { id: string; name: string; redirect_uris: string[]; token_endpoint_auth_method: string; secret_hash: string | null }

/** Public: discovery, registration, token exchange. */
export function oauthRoutes(sql: Sql, config: Pick<Config, 'publicUrl'>) {
  const app = new Hono<AppEnv>()

  const protectedResource = (c: Context) => {
    const origin = publicOrigin(c, config)
    return c.json({
      resource: `${origin}/mcp`,
      authorization_servers: [origin],
      scopes_supported: ['landed'],
      bearer_methods_supported: ['header'],
      resource_name: 'Landed',
      resource_documentation: `${origin}/agent?view=settings`,
    })
  }
  app.get('/.well-known/oauth-protected-resource', protectedResource)
  app.get('/.well-known/oauth-protected-resource/mcp', protectedResource)

  const authorizationServer = (c: Context) => {
    const origin = publicOrigin(c, config)
    return c.json({
      issuer: origin,
      authorization_endpoint: `${origin}/authorize-agent`,
      token_endpoint: `${origin}/oauth/token`,
      registration_endpoint: `${origin}/oauth/register`,
      response_types_supported: ['code'],
      response_modes_supported: ['query'],
      grant_types_supported: ['authorization_code', 'refresh_token'],
      code_challenge_methods_supported: ['S256'],
      token_endpoint_auth_methods_supported: AUTH_METHODS,
      scopes_supported: ['landed'],
      service_documentation: `${origin}/agent?view=settings`,
    })
  }
  app.get('/.well-known/oauth-authorization-server', authorizationServer)
  app.get('/.well-known/oauth-authorization-server/mcp', authorizationServer)

  app.post('/oauth/register', async (c) => {
    const ip = c.req.header('cf-connecting-ip') ?? c.req.header('x-forwarded-for')?.split(',')[0].trim() ?? 'local'
    if (tooManyRegistrations(ip)) return oauthError(c, 400, 'invalid_client_metadata', 'too many registrations from this address — try again later')
    let body: Record<string, unknown>
    try {
      body = await c.req.json()
    } catch {
      return oauthError(c, 400, 'invalid_client_metadata', 'body must be JSON')
    }
    const uris = body.redirect_uris
    if (!Array.isArray(uris) || uris.length === 0 || uris.length > MAX_REDIRECT_URIS || !uris.every(allowedRedirect)) {
      return oauthError(c, 400, 'invalid_redirect_uri', `redirect_uris: 1–${MAX_REDIRECT_URIS} https URLs (or http on localhost)`)
    }
    const method = body.token_endpoint_auth_method ?? 'none'
    if (!(AUTH_METHODS as readonly unknown[]).includes(method)) {
      return oauthError(c, 400, 'invalid_client_metadata', `token_endpoint_auth_method must be one of ${AUTH_METHODS.join(', ')}`)
    }
    const name = (typeof body.client_name === 'string' && body.client_name.trim() ? body.client_name.trim() : 'AI agent').slice(0, 80)
    const id = token('landed_client_')
    const secret = method === 'none' ? null : token('landed_secret_')
    await sql`
      insert into oauth_clients (id, name, redirect_uris, token_endpoint_auth_method, secret_hash)
      values (${id}, ${name}, ${uris as string[]}, ${method as string}, ${secret ? sha256(secret) : null})`
    return c.json({
      client_id: id,
      ...(secret ? { client_secret: secret, client_secret_expires_at: 0 } : {}),
      client_id_issued_at: Math.floor(Date.now() / 1000),
      client_name: name,
      redirect_uris: uris,
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      token_endpoint_auth_method: method,
      scope: 'landed',
    }, 201)
  })

  app.post('/oauth/token', async (c) => {
    // Form-encoded per RFC 6749; JSON accepted too.
    const type = c.req.header('content-type') ?? ''
    let p: Record<string, string>
    try {
      p = type.includes('application/json')
        ? Object.fromEntries(Object.entries(await c.req.json()).map(([k, v]) => [k, String(v)]))
        : Object.fromEntries(new URLSearchParams(await c.req.text()))
    } catch {
      return oauthError(c, 400, 'invalid_request', 'unreadable body')
    }
    // Client credentials: HTTP Basic, or client_id (+ client_secret) in the body.
    let clientId = p.client_id ?? ''
    let clientSecret = p.client_secret ?? ''
    const basic = c.req.header('authorization')
    if (basic?.toLowerCase().startsWith('basic ')) {
      const [id, secret] = Buffer.from(basic.slice(6), 'base64').toString('utf8').split(':')
      clientId = decodeURIComponent(id ?? '')
      clientSecret = decodeURIComponent(secret ?? '')
    }
    const [client] = await sql<Client[]>`select * from oauth_clients where id = ${clientId}`
    if (!client) return oauthError(c, 401, 'invalid_client', 'unknown client')
    if (client.token_endpoint_auth_method !== 'none' && !sameSecret(clientSecret, client.secret_hash)) {
      return oauthError(c, 401, 'invalid_client', 'bad client credentials')
    }

    if (p.grant_type === 'authorization_code') {
      if (!p.code || !p.code_verifier) return oauthError(c, 400, 'invalid_request', 'code and code_verifier are required')
      // One use only: the code is deleted as it is read.
      const [code] = await sql<{ client_id: string; user_id: string; redirect_uri: string; code_challenge: string; expired: boolean }[]>`
        delete from oauth_codes where code_hash = ${sha256(p.code)}
        returning client_id, user_id, redirect_uri, code_challenge, expires_at < now() as expired`
      if (!code || code.client_id !== client.id || code.expired) {
        return oauthError(c, 400, 'invalid_grant', 'the code is invalid, expired or already used')
      }
      if (p.redirect_uri && p.redirect_uri !== code.redirect_uri) return oauthError(c, 400, 'invalid_grant', 'redirect_uri does not match')
      if (S256(p.code_verifier) !== code.code_challenge) return oauthError(c, 400, 'invalid_grant', 'PKCE verification failed')
      const [{ active }] = await sql<{ active: number }[]>`
        select count(*)::int as active from agent_connections where user_id = ${code.user_id} and revoked_at is null`
      if (active >= MAX_ACTIVE_CONNECTIONS) return oauthError(c, 400, 'invalid_grant', `at most ${MAX_ACTIVE_CONNECTIONS} agents can be connected — remove one in Landed first`)
      const access = token('landed_mcp_')
      const refresh = token('landed_mcpr_')
      await sql`
        insert into agent_connections (user_id, provider, display_name, token_hash, scopes, oauth_client_id, refresh_hash, token_expires_at)
        values (${code.user_id}, 'mcp', ${client.name}, ${sha256(access)}, ${MCP_SCOPES}, ${client.id}, ${sha256(refresh)},
                now() + make_interval(secs => ${ACCESS_TTL_S}))`
      c.header('Cache-Control', 'no-store')
      return c.json({ access_token: access, token_type: 'Bearer', expires_in: ACCESS_TTL_S, refresh_token: refresh, scope: 'landed' })
    }

    if (p.grant_type === 'refresh_token') {
      if (!p.refresh_token) return oauthError(c, 400, 'invalid_request', 'refresh_token is required')
      const access = token('landed_mcp_')
      const refresh = token('landed_mcpr_')
      // Rotate both; the old refresh token stops working.
      const [row] = await sql`
        update agent_connections
        set token_hash = ${sha256(access)}, refresh_hash = ${sha256(refresh)},
            token_expires_at = now() + make_interval(secs => ${ACCESS_TTL_S})
        where refresh_hash = ${sha256(p.refresh_token)} and oauth_client_id = ${client.id} and revoked_at is null
        returning id`
      if (!row) return oauthError(c, 400, 'invalid_grant', 'the refresh token is invalid or was revoked')
      c.header('Cache-Control', 'no-store')
      return c.json({ access_token: access, token_type: 'Bearer', expires_in: ACCESS_TTL_S, refresh_token: refresh, scope: 'landed' })
    }

    return oauthError(c, 400, 'unsupported_grant_type', 'use authorization_code or refresh_token')
  })

  return app
}

/** Validate an authorization request (the query the client sent the user
 *  with). Returns the client, or a message for the page. */
async function checkRequest(sql: Sql, q: Record<string, unknown>): Promise<{ client: Client } | { error: string }> {
  const [client] = await sql<Client[]>`select * from oauth_clients where id = ${String(q.client_id ?? '')}`
  if (!client) return { error: "This app isn't registered with Landed. Start connecting again from the app." }
  if (typeof q.redirect_uri !== 'string' || !client.redirect_uris.includes(q.redirect_uri)) return { error: 'This request has an unexpected return address, so Landed stopped it.' }
  if (q.response_type !== 'code') return { error: 'Unsupported request (response_type must be code).' }
  if (q.code_challenge_method !== 'S256' || typeof q.code_challenge !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(q.code_challenge)) {
    return { error: 'Unsupported request (PKCE with S256 is required).' }
  }
  return { client }
}

/** Signed-in: the consent page's two calls. */
export function oauthAccountRoutes(sql: Sql, config: Pick<Config, 'publicUrl'>) {
  const app = new Hono<AppEnv>()

  app.get('/oauth/authorize-info', async (c) => {
    const r = await checkRequest(sql, c.req.query())
    if ('error' in r) fail(400, r.error)
    return c.json({ client_name: r.client.name, redirect_host: new URL(c.req.query('redirect_uri')!).host })
  })

  app.post('/oauth/approve', async (c) => {
    const body = await jsonBody<Record<string, unknown>>(c)
    const r = await checkRequest(sql, body)
    if ('error' in r) fail(400, r.error)
    const back = new URL(body.redirect_uri as string)
    if (typeof body.state === 'string') back.searchParams.set('state', body.state)
    back.searchParams.set('iss', publicOrigin(c, config))
    if (body.decision !== 'allow') {
      back.searchParams.set('error', 'access_denied')
      return c.json({ redirect: back.toString() })
    }
    const code = token('landed_code_')
    await sql`
      insert into oauth_codes (code_hash, client_id, user_id, redirect_uri, code_challenge, expires_at)
      values (${sha256(code)}, ${r.client.id}, ${c.get('user').id}, ${body.redirect_uri as string}, ${body.code_challenge as string},
              ${new Date(Date.now() + CODE_TTL_MS)})`
    back.searchParams.set('code', code)
    return c.json({ redirect: back.toString() })
  })

  return app
}

/** Hourly: expired codes, and clients that registered but never connected. */
export async function purgeOAuth(sql: Sql) {
  await sql`delete from oauth_codes where expires_at < now()`
  await sql`
    delete from oauth_clients c
    where c.created_at < now() - interval '1 day'
      and not exists (select 1 from agent_connections a where a.oauth_client_id = c.id)
      and not exists (select 1 from oauth_codes o where o.client_id = c.id)`
}
