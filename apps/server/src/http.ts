// Shared HTTP helpers: typed errors, Postgres error mapping, body parsing.
import type { Context } from 'hono'
import { HTTPException } from 'hono/http-exception'
import type { ContentfulStatusCode } from 'hono/utils/http-status'

export function fail(status: ContentfulStatusCode, message: string, extra?: Record<string, unknown>): never {
  throw new HTTPException(status, {
    res: new Response(JSON.stringify({ error: message, ...extra }), {
      status,
      headers: { 'Content-Type': 'application/json' },
    }),
  })
}

export async function jsonBody<T = Record<string, unknown>>(c: Context): Promise<T> {
  let body: unknown
  try {
    body = await c.req.json()
  } catch {
    fail(400, 'invalid JSON body')
  }
  if (typeof body !== 'object' || body === null) fail(400, 'body must be a JSON object or array')
  return body as T
}

/** Copy only the allowed keys that are present (undefined = not sent).
 *  Values are JSON-decoded request data, typed loosely for the sql() helper. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function pick<K extends string>(src: Record<string, unknown>, keys: readonly K[]): Partial<Record<K, any>> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const out: Partial<Record<K, any>> = {}
  for (const k of keys) if (src[k] !== undefined) out[k] = src[k]
  return out
}

// Postgres SQLSTATEs that mean "the client sent bad data", not "we broke".
// 22P02 invalid enum/uuid text, 23514 check, 23502 not-null, 23503 FK
// (includes the composite same-owner FKs), 22001 value too long.
const CLIENT_ERRORS: Record<string, ContentfulStatusCode> = {
  '22P02': 400, '22001': 400, '22007': 400, '22008': 400, '23502': 400, '23514': 400,
  '23503': 400, '23505': 409,
}

export function pgErrorStatus(err: unknown): ContentfulStatusCode | null {
  const code = (err as { code?: unknown })?.code
  return typeof code === 'string' ? (CLIENT_ERRORS[code] ?? null) : null
}
