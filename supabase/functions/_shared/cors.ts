// Shared CORS helpers for Edge Functions.
//
// The MV3 browser extension (Sprint 4) calls these endpoints from arbitrary
// portal-vendor origins (greenhouse.com, lever.co, workday.com, …) and from
// chrome-extension://<id>. We accept any origin because the JWT in the
// Authorization header is the real authn boundary — CORS isn't doing security
// for us here.
//
// If we ever want to tighten this (e.g. only allow our published extension
// origin), drop the wildcard and switch to a small allowlist keyed off
// `req.headers.get('origin')`.

export const corsHeaders: Record<string, string> = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers':
    'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Max-Age': '86400',
}

/**
 * Handle the CORS preflight request. Returns a Response if the method is
 * OPTIONS (so the caller should `return` it immediately); otherwise returns
 * null and the caller proceeds with normal handling.
 */
export function handlePreflight(req: Request): Response | null {
  if (req.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: corsHeaders })
  }
  return null
}

/** JSON response with CORS headers baked in. */
export function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  })
}
