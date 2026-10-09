// Thin client for the Landed API server (apps/server), used only in Landed
// Cloud mode (lib/store/cloud.ts) and for auth (lib/auth.ts, lib/cloud.ts).
//
// Same-origin: in dev Vite proxies /api to the server (vite.config.ts); in
// production the server serves this bundle itself. Auth rides on the
// httpOnly session cookie, so there is no token handling here.

export class ApiError extends Error {
  status: number
  constructor(status: number, message: string) {
    super(message)
    this.status = status
  }
}

// Called on any 401 from a data endpoint (session expired / revoked
// server-side) so the auth store can drop back to the login screen.
let onUnauthorized: (() => void) | null = null
export function setUnauthorizedHandler(fn: (() => void) | null) {
  onUnauthorized = fn
}

async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch('/api' + path, {
    method,
    credentials: 'same-origin',
    headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  if (res.status === 204) return undefined as T
  const text = await res.text()
  let data: any = null
  try {
    data = text ? JSON.parse(text) : null
  } catch {
    // non-JSON error page (e.g. proxy down) — fall through with raw text
  }
  if (!res.ok) {
    if (res.status === 401 && !path.startsWith('/auth/')) onUnauthorized?.()
    throw new ApiError(res.status, data?.error ?? `${method} ${path} failed (${res.status})`)
  }
  return data as T
}

export const api = {
  get: <T>(path: string) => request<T>('GET', path),
  post: <T>(path: string, body?: unknown) => request<T>('POST', path, body ?? {}),
  put: <T>(path: string, body: unknown) => request<T>('PUT', path, body),
  patch: <T>(path: string, body: unknown) => request<T>('PATCH', path, body),
  del: <T = void>(path: string, body?: unknown) => request<T>('DELETE', path, body),
}
