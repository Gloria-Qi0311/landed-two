// Normalization — every comparison the processor makes runs on these keys,
// never on raw agent text. See docs/observation-processor.md §2.

const LEGAL_SUFFIXES = new Set([
  'inc', 'incorporated', 'llc', 'ltd', 'limited', 'corp', 'corporation', 'co', 'company',
  'gmbh', 'plc', 'ag', 'sa', 'bv', 'pte', 'pty', 'srl', 'oy', 'ab', 'kk',
])

// Hand-maintained to start; user merges can feed it later.
const COMPANY_ALIASES: Record<string, string> = {
  'meta platforms': 'meta',
  facebook: 'meta',
  alphabet: 'google',
  'google llc': 'google',
  'amazon com': 'amazon',
  'amazon web services': 'amazon',
  aws: 'amazon',
  'microsoft corporation': 'microsoft',
  'x corp': 'x',
  twitter: 'x',
}

function words(s: string): string[] {
  return s
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '') // strip accents
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .split(/\s+/)
    .filter(Boolean)
}

/** "The Acme Corp., Inc." → "acme" */
export function companyKey(name: string | null | undefined): string {
  if (!name) return ''
  const w = words(name)
  if (w[0] === 'the' && w.length > 1) w.shift()
  while (w.length > 1 && LEGAL_SUFFIXES.has(w[w.length - 1])) w.pop()
  const key = w.join(' ')
  return COMPANY_ALIASES[key] ?? key
}

const TITLE_EXPANSIONS: Record<string, string[]> = {
  sr: ['senior'],
  snr: ['senior'],
  jr: ['junior'],
  eng: ['engineer'],
  engr: ['engineer'],
  swe: ['software', 'engineer'],
  sde: ['software', 'engineer'],
  pm: ['product', 'manager'],
  tpm: ['technical', 'program', 'manager'],
  mgr: ['manager'],
  dev: ['developer'],
  ml: ['machine', 'learning'],
  ai: ['ai'],
}

/** Title words with abbreviations expanded and bracketed noise (locations,
 *  req ids) removed. Seniority words are kept: Senior PM ≠ PM. */
export function titleWords(title: string | null | undefined): string[] {
  if (!title) return []
  const cleaned = title.replace(/\([^)]*\)|\[[^\]]*\]/g, ' ')
  return words(cleaned).flatMap((w) => TITLE_EXPANSIONS[w] ?? [w])
}

export function titleKey(title: string | null | undefined): string {
  return titleWords(title).join(' ')
}

/** Jaccard similarity of normalized title words (0..1). */
export function titleSimilarity(a: string | null | undefined, b: string | null | undefined): number {
  const A = new Set(titleWords(a))
  const B = new Set(titleWords(b))
  if (A.size === 0 || B.size === 0) return 0
  let inter = 0
  for (const w of A) if (B.has(w)) inter++
  return inter / (A.size + B.size - inter)
}

const TRACKING_PARAMS = /^(utm_.*|gh_src|lever-source|lever-origin|source|src|ref|referrer|trk|trackingid|_hsenc|_hsmi|mc_cid|mc_eid|fbclid|gclid)$/i

/** Lowercase host, no fragment, no tracking params, no trailing slash. */
export function canonicalUrl(raw: string | null | undefined): string | null {
  if (!raw) return null
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    return null
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null
  url.hash = ''
  url.protocol = 'https:'
  url.hostname = url.hostname.toLowerCase().replace(/^www\./, '')
  for (const key of [...url.searchParams.keys()]) {
    if (TRACKING_PARAMS.test(key)) url.searchParams.delete(key)
  }
  url.searchParams.sort()
  const path = url.pathname.replace(/\/+$/, '') || '/'
  return `${url.hostname}${path}${url.search}`
}

/** Stable ATS job identity, the strongest dedupe signal we have. */
export function atsJobKey(raw: string | null | undefined): string | null {
  if (!raw) return null
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    return null
  }
  const host = url.hostname.toLowerCase()
  const parts = url.pathname.split('/').filter(Boolean)

  // Greenhouse job ids are global across Greenhouse, so the board slug or
  // careers domain doesn't matter: boards.greenhouse.io/{co}/jobs/{id},
  // job-boards.greenhouse.io/..., or any page carrying ?gh_jid={id}.
  const ghJid = url.searchParams.get('gh_jid')
  if (ghJid && /^\d+$/.test(ghJid)) return `greenhouse:${ghJid}`
  if (/(^|\.)greenhouse\.io$/.test(host)) {
    const i = parts.indexOf('jobs')
    if (i > 0 && /^\d+$/.test(parts[i + 1] ?? '')) return `greenhouse:${parts[i + 1]}`
  }

  // Lever and Ashby posting ids are global UUIDs: jobs.lever.co/{co}/{uuid},
  // jobs.ashbyhq.com/{co}/{uuid}.
  if (/(^|\.)lever\.co$/.test(host) && parts.length >= 2 && /^[0-9a-f-]{36}$/i.test(parts[1])) {
    return `lever:${parts[1].toLowerCase()}`
  }
  if (/(^|\.)ashbyhq\.com$/.test(host) && parts.length >= 2 && /^[0-9a-f-]{36}$/i.test(parts[1])) {
    return `ashby:${parts[1].toLowerCase()}`
  }

  // Workday requisition ids are only unique per tenant.
  const wd = host.match(/^([a-z0-9-]+)\.(?:wd\d+\.)?myworkday(?:jobs|site)\.com$/)
  if (wd) {
    const last = parts[parts.length - 1] ?? ''
    const req = last.match(/_([A-Za-z0-9-]+)$/)
    if (parts.includes('job') && req) return `workday:${wd[1]}:${req[1].toLowerCase()}`
  }

  return null
}

/** First comma part, lowercased: "San Francisco, CA" → "san francisco". */
function city(location: string | null | undefined): string {
  return (location ?? '').split(/[,;/|]/)[0].trim().toLowerCase()
}

/** Same city, or either side remote / unknown. */
export function locationsCompatible(a: string | null | undefined, b: string | null | undefined): boolean {
  const ca = city(a)
  const cb = city(b)
  if (!ca || !cb) return true
  if (/\bremote\b/.test(ca) || /\bremote\b/.test(cb)) return true
  return ca === cb
}
