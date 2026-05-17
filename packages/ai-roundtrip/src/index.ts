// @landed/ai-roundtrip — the "no paid AI API" primitive.
//
// Pattern (per spec.md §5):
//   1. generatePrompt(task, input, schema?) → string
//   2. launchAI(provider, prompt) → copies to clipboard + opens new tab
//   3. user pastes the AI's reply into a textarea in our UI
//   4. tryParseResponse(text, schema?) → 3-tier { ok, format, parsed | error }
//   5. saveAiRun(client, { task, provider, prompt, response, parsed, parseFormat })
//      writes to the ai_runs table (rls-scoped to the current user).
//
// Consumed by:
//   - apps/web: Resume Match (#21) / JD Breakdown (#22) / Resumes upload (#20)
//   - apps/extension: PDF parse round-trip (#32) — extension uses the same
//     parser but launches its own UI
//
// Deliberate non-features:
//   - We don't auto-fill the AI's input box (browser automation we can't ship).
//   - We don't store the AI conversation history — just the prompt we sent +
//     the response the user pasted back.
import type { SupabaseClient } from '@supabase/supabase-js'
import type { ZodType } from 'zod'

// ─── providers ────────────────────────────────────────────────────────────

export type Provider = 'chatgpt' | 'claude' | 'gemini' | 'other'

export const PROVIDERS: Record<
  Exclude<Provider, 'other'>,
  { url: string; label: string }
> = {
  chatgpt: { url: 'https://chat.openai.com', label: 'ChatGPT' },
  claude: { url: 'https://claude.ai', label: 'Claude' },
  gemini: { url: 'https://gemini.google.com', label: 'Gemini' },
}

// ─── tasks ────────────────────────────────────────────────────────────────

export type AiTask =
  | 'resume_match'
  | 'jd_breakdown'
  | 'resume_tailor'
  | 'resume_parse'

// ─── truncation ───────────────────────────────────────────────────────────

/**
 * ~4k tokens at the typical ~4 chars/token ratio. Matches spec.md §8 #7.
 * Most provider context windows handle far more, but keeping prompts tight
 * (a) stays under hidden per-prompt limits across providers, (b) reduces
 * the risk of the LLM dropping early context, and (c) is fast to paste.
 */
export const PROMPT_MAX_JD_CHARS = 16_000

/**
 * Cap a long string at `maxChars` and append a visible "[truncated]" marker
 * so the LLM (and the user inspecting the prompt) knows content was cut.
 * Returns the truncated text + a `truncated` flag + the original length so
 * callers can surface a "JD truncated — consider a 2-pass summarize+rank"
 * hint in their UI.
 */
export function truncateForPrompt(
  text: string,
  maxChars: number = PROMPT_MAX_JD_CHARS,
): { text: string; truncated: boolean; originalChars: number } {
  const original = text ?? ''
  if (original.length <= maxChars) {
    return { text: original, truncated: false, originalChars: original.length }
  }
  // Cut at a paragraph break near the limit if we can find one in the last 200 chars.
  // Guard against -1 (no break found) and small breaks near offset 0.
  const cut = original.slice(0, maxChars)
  const lastBreak = cut.lastIndexOf('\n\n')
  const sliceAt = lastBreak > 0 && lastBreak >= maxChars - 200 ? lastBreak : maxChars
  const truncated =
    original.slice(0, sliceAt) +
    `\n\n[...truncated from ${original.length} chars to ${sliceAt}; ${original.length - sliceAt} chars omitted...]`
  return { text: truncated, truncated: true, originalChars: original.length }
}

// ─── 1. generatePrompt ────────────────────────────────────────────────────

/**
 * Build a prompt string for the given task. Each task has its own template
 * but they share a common shape:
 *   - Brief instruction
 *   - Output schema (JSON shape we expect back)
 *   - Structured input (resume / JDs / etc.)
 *
 * `schemaText` is the literal JSON-shaped string we want returned. Callers
 * typically pass JSON.stringify(SomeZodSchema.parse({}), null, 2) so the
 * LLM sees the exact field names.
 */
export function generatePrompt(
  task: AiTask,
  input: Record<string, unknown>,
  schemaText?: string,
): string {
  switch (task) {
    case 'resume_match':
      return buildResumeMatchPrompt(input, schemaText)
    case 'jd_breakdown':
      return buildJdBreakdownPrompt(input, schemaText)
    case 'resume_tailor':
      return buildResumeTailorPrompt(input, schemaText)
    case 'resume_parse':
      return buildResumeParsePrompt(input, schemaText)
  }
}

function buildResumeMatchPrompt(input: Record<string, unknown>, schemaText?: string): string {
  const resume = input.resume ?? '<no resume provided>'
  const jds = Array.isArray(input.jds) ? input.jds : []
  const expected = schemaText ?? `{
  "rankings": [
    { "jd_id": "jd1", "rank": 1, "score": 8.5, "reasons": ["..."], "gaps": ["..."] }
  ]
}`
  return [
    'Rank the following job descriptions against the candidate resume below.',
    '',
    'Return ONLY JSON in this exact shape (no commentary, no markdown fence):',
    expected,
    '',
    'Rules: score is 0-10 (decimals OK). reasons and gaps are short bullet strings (max 6 each). rank is 1 = best fit. Sort the array by rank ascending.',
    '',
    '# RESUME',
    typeof resume === 'string' ? resume : JSON.stringify(resume, null, 2),
    '',
    '# JDS',
    jds
      .map((jd: any, i: number) => {
        const truncated = truncateForPrompt(jd.body ?? '')
        return `## ${jd.id ?? `jd${i + 1}`} — ${jd.title ?? ''}\n${truncated.text}`
      })
      .join('\n\n'),
  ].join('\n')
}

function buildJdBreakdownPrompt(input: Record<string, unknown>, schemaText?: string): string {
  const jd: any = input.jd ?? {}
  const resume = input.resume
  const expected = schemaText ?? `{
  "must_have": ["..."],
  "nice_to_have": ["..."],
  "gaps": [{ "skill": "...", "weeks_to_close": 2, "why": "..." }],
  "match_percent": 0
}`
  const jdBody = truncateForPrompt(jd.body ?? '').text
  return [
    'Extract the requirements from this job description.',
    resume ? 'Compare against the candidate resume and surface gaps.' : '',
    '',
    'Return ONLY JSON in this exact shape (no commentary, no markdown fence):',
    expected,
    '',
    '# JD',
    `## ${jd.title ?? ''}`,
    jdBody,
    resume ? '\n# RESUME\n' + (typeof resume === 'string' ? resume : JSON.stringify(resume, null, 2)) : '',
  ].filter(Boolean).join('\n')
}

function buildResumeTailorPrompt(input: Record<string, unknown>, schemaText?: string): string {
  const resume = input.resume
  const jd: any = input.jd ?? {}
  const expected = schemaText ?? `{
  "tailored_bullets": [
    { "original": "...", "tailored": "...", "reason": "..." }
  ]
}`
  return [
    'Rewrite the resume bullets below to better match the target job description. Preserve every truth claim — do not invent skills, employers, or accomplishments. Tighten language, lead with impact verbs, and surface the keywords the JD calls out.',
    '',
    'Return ONLY JSON in this exact shape (no commentary, no markdown fence):',
    expected,
    '',
    '# TARGET JD',
    `## ${jd.title ?? ''}`,
    jd.body ?? '',
    '',
    '# RESUME',
    typeof resume === 'string' ? resume : JSON.stringify(resume, null, 2),
  ].join('\n')
}

// Supported language codes for resume_parse translation. 'auto' means
// "detect the source language first" and only applies to sourceLang.
export type ResumeLang = 'auto' | 'en' | 'zh-CN' | 'zh-TW' | 'ja'

const LANG_LABEL: Record<ResumeLang, string> = {
  'auto':  'auto-detect',
  'en':    'English',
  'zh-CN': 'Chinese (Simplified, 简体中文)',
  'zh-TW': 'Chinese (Traditional, 繁體中文)',
  'ja':    'Japanese (日本語)',
}

function buildResumeParsePrompt(
  input?: Record<string, unknown>,
  schemaText?: string,
): string {
  const sourceLang = (input?.sourceLang as ResumeLang) ?? 'auto'
  const targetLang = (input?.targetLang as ResumeLang) ?? 'en'
  // Translation block fires when (a) sourceLang is auto (we don't know yet),
  // or (b) we know source != target. When both are explicitly the same
  // language, skip the translation block entirely — the prompt stays lean.
  const needsTranslation =
    sourceLang === 'auto' || sourceLang !== targetLang

  // Schema mirrors @landed/schema's Resume shape verbatim, including the 5
  // bilingual name fields (firstName/lastName/englishName/chineseName) and
  // wechat that zod accepts. Earlier prompt versions omitted these and the
  // fields stayed permanently empty — dead schema columns.
  const expected = schemaText ?? `{
  "version": 2,
  "basic": {
    "name": "",
    "firstName": "",
    "lastName": "",
    "englishName": "",
    "chineseName": "",
    "email": "",
    "phone": "",
    "wechat": "",
    "location": "",
    "linkedin": "",
    "github": "",
    "portfolio": ""
  },
  "intent": { "apply_position": "", "salary": "", "available_date": "", "years_exp": "" },
  "education": [
    { "school": "", "degree": "", "major": "", "gpa": "", "start_date": "", "end_date": "", "location": "", "description": "" }
  ],
  "experience": [
    { "company": "", "title": "", "location": "", "start_date": "", "end_date": "", "current": false, "description": "" }
  ],
  "internship": [
    { "company": "", "title": "", "location": "", "start_date": "", "end_date": "", "current": false, "description": "" }
  ],
  "projects": [
    { "name": "", "role": "", "link": "", "start_date": "", "end_date": "", "description": "" }
  ],
  "skills": [],
  "languages": [],
  "summary": ""
}`
  const translationBlock = needsTranslation
    ? [
        '',
        'Translation:',
        `- Source language: ${LANG_LABEL[sourceLang]}. Target language: ${LANG_LABEL[targetLang]}.`,
        sourceLang === 'auto'
          ? '- Detect the resume\'s source language first. If it differs from the target, translate descriptive prose into the target language while parsing. If they match, parse in place without translation.'
          : '- Translate descriptive prose into the target language while parsing.',
        '- TRANSLATE these fields when crossing languages: title, role, major, degree, location, description, summary, intent.apply_position.',
        '- DO NOT TRANSLATE proper nouns: company names, school names, technology names (React, Python, Kubernetes, etc.), product names, names of competitions / contests / challenges / hackathons / events / programs, person names, brand names, social handles, URLs, emails, phone numbers, GPA values. Keep these in their original form.',
        '- For a competition or event name, keep the original name verbatim; if the target-language reader would not recognize it, you MAY append a recognizable form in parentheses ONCE — e.g. "飞书 AI 校园挑战赛 (Lark AI Campus Challenge)" — but never replace the original with a translated paraphrase.',
        '- A multi-word name is still a single proper noun as a whole. Do NOT translate it word-by-word just because each component word is translatable — test whether the entire string is the official NAME of a thing (a contest, a product, a program, an institution). If yes, keep it.',
        '- If a proper noun has a well-known canonical form in the target language (e.g. 上海交通大学 ↔ Shanghai Jiao Tong University, 飞书 ↔ Lark, 字节跳动 ↔ ByteDance), prefer the form the institution itself uses; when in doubt, keep the source form.',
        '- JSON field names (keys) stay in English regardless of language settings.',
      ].join('\n')
    : ''

  return [
    'You are a resume parser. Parse the resume below into the JSON schema.',
    '',
    'OUTPUT DISCIPLINE — non-negotiable:',
    '- Respond with a SINGLE JSON object and nothing else.',
    '- DO NOT write any text before the opening {.',
    '- DO NOT wrap the JSON in markdown code fences (no ```json, no ```).',
    '- DO NOT write any notes, explanations, or "A couple of notes:" after the closing }.',
    '- DO NOT preface with "Here is the parsed JSON:" / "Let me work through this:" / "I\'ll parse..." or any similar lead-in.',
    '- DO NOT describe your classification reasoning, decisions, or self-checks anywhere in the output. The JSON is the entire response.',
    '',
    'Rules:',
    '1. For fields you cannot extract, use "" or [] — never fabricate.',
    '2. Normalize dates to "YYYY-MM" or "YYYY-MM-DD". For ongoing roles, leave end_date "" and set current: true.',
    '3. Sort education / experience / internship / projects in reverse chronological order (most recent first).',
    '4. skills and languages are flat string arrays.',
    '5. Split name into firstName / lastName. For Chinese names: put the family name in lastName, given name in firstName, and the full Chinese form in chineseName. Use englishName for an English alias if present.',
    '6. Escape any " inside string values as \\". Do NOT use 「」 『』 or other special quote characters — replace with plain text or standard quotes.',
    '7. In description fields, separate bullet points with periods — never use newline characters inside a string value.',
    '8. Validate the JSON silently before output (balanced braces, no trailing commas, all keys quoted, escaped quotes inside strings, no unescaped control characters). Do NOT mention or describe this validation in the output.',
    '9. CLASSIFICATION — experience vs internship vs projects. Apply this decision order strictly:',
    '   - internship: a paid or formally hosted position at a company/organization where the person was an employee or official intern. Signals: a job title at a named employer, an employment relationship, and the word "intern" / "实习" appearing in the entry\'s TITLE or POSITION field (NOT in the description body — a competition entry whose description mentions "as an intern PM" is still a competition). → goes in `internship`.',
    '   - experience: a full-time or long-term employment position that is NOT an internship. → goes in `experience`.',
    '   - projects: any competition, hackathon, challenge, contest, course project, lab project, research project, or self-initiated product. A named contest or event (anything ending in 挑战赛 / 大赛 / 比赛 / hackathon / challenge / cup / competition / program) is ALWAYS a project, NEVER an internship — even if the person held a PM / lead / organizer title within it, and even if it was hosted or sponsored by a major company. → goes in `projects`.',
    '   - If an entry could fit multiple categories, prefer the more specific one in this priority: competition/contest → projects; otherwise employment → internship / experience.',
    '   - When the resume groups entries under explicit section headers (e.g. "相关经验" vs "核心项目"), use those headers as a tiebreaker — but the competition-is-always-a-project test above OVERRIDES section placement.',
    '10. Do not infer an entry\'s category from its description content. A challenge / competition project keeps its event nature even if the work resembles a real job (product launches, team leadership, KPIs hit). Category comes from WHAT THE ENTRY IS, not what the person did inside it.',
    translationBlock,
    '',
    'Target schema (return JSON in this exact shape):',
    expected,
    '',
    'REMINDER: respond with the JSON object only. First character of your response must be {. Last character must be }. No prose anywhere — not before, not after, not inside.',
  ].filter(Boolean).join('\n')
}

// ─── 2. launchAI ──────────────────────────────────────────────────────────

export type LaunchResult =
  | { ok: true }
  | { ok: false; reason: string }

/**
 * Copy prompt to clipboard + open the provider's chat URL in a new tab.
 * Returns ok=false with a user-readable reason if either step fails so the
 * UI can surface a fallback (e.g. "popup blocked — paste from clipboard").
 */
export async function launchAI(provider: Provider, prompt: string): Promise<LaunchResult> {
  if (provider === 'other') {
    return { ok: false, reason: 'Provider "other" has no preset URL — write your own launcher.' }
  }
  const cfg = PROVIDERS[provider]
  if (!cfg) return { ok: false, reason: `Unknown provider: ${provider}` }

  // Copy to clipboard. navigator.clipboard requires a secure context (https
  // or localhost) AND a recent user gesture — typically fine when launched
  // from a button click.
  try {
    await navigator.clipboard.writeText(prompt)
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    return { ok: false, reason: `Clipboard write failed: ${msg}` }
  }

  // Open the provider. Popup-blocked windows return null per the spec.
  const win = window.open(cfg.url, '_blank', 'noopener,noreferrer')
  if (!win) {
    return {
      ok: false,
      reason:
        'Popup blocked. Allow popups for this site, or paste the prompt manually — it is already on your clipboard.',
    }
  }
  return { ok: true }
}

// ─── 3. tryParseResponse ──────────────────────────────────────────────────

export type ParseFormat = 'json' | 'markdown' | 'heuristic' | 'failed'

export type ParseResult<T = unknown> =
  | { ok: true; format: Exclude<ParseFormat, 'failed'>; parsed: T }
  | { ok: false; format: 'failed'; error: string }

/**
 * Tier 1: JSON.parse (after stripping ```json fences). If a zod schema is
 *         provided AND validation passes, return it as `format: 'json'`.
 *         If JSON is valid but schema fails, still pass it through as JSON
 *         — the caller can decide whether to surface schema errors or use
 *         the raw parsed object.
 * Tier 2: Markdown table — detect lines starting and ending with `|`,
 *         coerce numeric cells. Wraps in `{ rankings: rows }` if header
 *         looks like a ranking table (jd_id / rank / score columns).
 * Tier 3: Plain text — look for `JD1: 8/10` / `#2 - 7.5` / similar
 *         lines. Collects into `{ rankings: [...] }`.
 *
 * Returns `format: 'failed'` only when ALL three tiers strike out.
 */
export function tryParseResponse<T = unknown>(
  text: string,
  expectedSchema?: ZodType<T>,
): ParseResult<T> {
  if (!text || !text.trim()) {
    return { ok: false, format: 'failed', error: 'Empty input.' }
  }

  // Tier 1 — JSON (with code-fence stripping + most-likely-object slice)
  const jsonText = extractJsonBlock(text)
  if (jsonText) {
    try {
      const parsed = JSON.parse(jsonText)
      if (expectedSchema) {
        const validated = expectedSchema.safeParse(parsed)
        if (validated.success) {
          return { ok: true, format: 'json', parsed: validated.data }
        }
        // valid JSON but schema mismatch — still return JSON tier with raw
        // parsed object; UI can show schema errors if it wants.
        return { ok: true, format: 'json', parsed: parsed as T }
      }
      return { ok: true, format: 'json', parsed: parsed as T }
    } catch {
      /* fall through */
    }
  }

  // Tier 2 — Markdown table
  const fromTable = parseMarkdownTable(text)
  if (fromTable) {
    return { ok: true, format: 'markdown', parsed: fromTable as T }
  }

  // Tier 3 — Plain text heuristic
  const fromText = parsePlainTextRankings(text)
  if (fromText) {
    return { ok: true, format: 'heuristic', parsed: fromText as T }
  }

  return {
    ok: false,
    format: 'failed',
    error:
      'Could not parse response. Try asking the model to "return ONLY JSON" + retry, or fill the fields manually.',
  }
}

// Strip ```json ... ``` fences and isolate the first {...} or [...] block.
function extractJsonBlock(text: string): string | null {
  let s = text.trim()
  // Strip fences greedy
  s = s.replace(/```(?:json|jsonc|json5)?/gi, '').replace(/```/g, '').trim()
  if (!s) return null
  // Find the first balanced JSON-looking object/array
  const firstCurly = s.indexOf('{')
  const firstSquare = s.indexOf('[')
  let start = -1
  if (firstCurly < 0 && firstSquare < 0) return null
  if (firstCurly < 0) start = firstSquare
  else if (firstSquare < 0) start = firstCurly
  else start = Math.min(firstCurly, firstSquare)

  const open = s[start]
  const close = open === '{' ? '}' : ']'
  let depth = 0
  let inString = false
  let escape = false
  for (let i = start; i < s.length; i++) {
    const ch = s[i]
    if (escape) {
      escape = false
      continue
    }
    if (ch === '\\') {
      escape = true
      continue
    }
    if (ch === '"') {
      inString = !inString
      continue
    }
    if (inString) continue
    if (ch === open) depth++
    else if (ch === close) {
      depth--
      if (depth === 0) return s.slice(start, i + 1)
    }
  }
  // Unbalanced — return raw to let JSON.parse fail loudly
  return s
}

function parseMarkdownTable(text: string): unknown | null {
  const lines = text.split('\n').map((l) => l.trim())
  const tableLines = lines.filter((l) => l.startsWith('|') && l.endsWith('|'))
  if (tableLines.length < 2) return null

  const parseRow = (line: string): string[] =>
    line.slice(1, -1).split('|').map((c) => c.trim())

  const headers = parseRow(tableLines[0]).map((h) =>
    h.toLowerCase().replace(/\s+/g, '_').replace(/[^a-z0-9_]/g, ''),
  )
  if (headers.length === 0) return null

  // Skip separator row (| --- | --- |) if present
  const dataLines = tableLines.slice(1).filter((l) => !/^\|[\s\-:]+\|/.test(l))
  if (dataLines.length === 0) return null

  const rows = dataLines.map((line) => {
    const cells = parseRow(line)
    const row: Record<string, unknown> = {}
    headers.forEach((h, i) => {
      const raw = cells[i] ?? ''
      // Numeric coercion when the cell looks like a clean number
      if (/^-?\d+(\.\d+)?$/.test(raw)) {
        row[h] = parseFloat(raw)
      } else {
        row[h] = raw
      }
    })
    return row
  })

  const looksLikeRankings =
    headers.includes('jd_id') || headers.includes('rank') || headers.includes('score')
  if (looksLikeRankings) {
    return { rankings: rows }
  }
  return rows
}

function parsePlainTextRankings(text: string): unknown | null {
  const lines = text.split('\n').map((l) => l.trim()).filter(Boolean)
  const rankings: Array<{ jd_id: string; score: number; line: string }> = []
  for (const line of lines) {
    // Patterns we accept (case-insensitive). The id token (digit-or-slug)
    // must be immediately followed by a separator (:, -, —, –) and a number:
    //   "JD1: 8/10 — reasons..."
    //   "JD 2 - 7.5 strong fit"
    //   "#3: 6"
    //   "item foo: 9"
    // Looser patterns like "1. JD-foo  score: 9" (id and score separated by
    // a word, no separator) fall through to 'failed' — caller can re-prompt
    // the model to use the explicit JSON format.
    const m = line.match(
      /(?:jd|item|#)[\s-]?(\d+|[a-z0-9_-]+)\s*[:\-—–]\s*(?:score\s*[:=]?\s*)?(\d+(?:\.\d+)?)/i,
    )
    if (m) {
      rankings.push({
        jd_id: /^\d+$/.test(m[1]) ? `jd${m[1]}` : m[1],
        score: parseFloat(m[2]),
        line,
      })
    }
  }
  if (rankings.length === 0) return null
  // Assign rank by score descending
  rankings.sort((a, b) => b.score - a.score)
  return {
    rankings: rankings.map((r, i) => ({
      jd_id: r.jd_id,
      rank: i + 1,
      score: r.score,
      reasons: [r.line],
    })),
  }
}

// ─── 4. saveAiRun ─────────────────────────────────────────────────────────

export type SaveAiRunInput = {
  task: AiTask
  provider: Provider
  prompt: string
  response?: string
  parsed?: unknown
  parseFormat?: ParseFormat
}

export type SaveAiRunResult =
  | { ok: true; id: string }
  | { ok: false; error: string }

/**
 * Persist a single round-trip to the ai_runs table. Caller supplies the
 * Supabase client (apps/web's anon client, apps/extension's once it lands).
 * user_id is derived from supabase.auth.getUser() — RLS enforces ownership.
 */
export async function saveAiRun(
  // SupabaseClient is generic over Database; we don't import Database types
  // here to keep the package decoupled from any one project's generated types.
  client: SupabaseClient,
  run: SaveAiRunInput,
): Promise<SaveAiRunResult> {
  const userRes = await client.auth.getUser()
  const userId = userRes.data.user?.id
  if (!userId) return { ok: false, error: 'Not signed in.' }

  const { data, error } = await client
    .from('ai_runs')
    .insert({
      user_id: userId,
      task: run.task,
      provider: run.provider,
      prompt_text: run.prompt,
      response_text: run.response ?? null,
      parsed_json: run.parsed ?? null,
      parse_format: run.parseFormat ?? null,
    })
    .select('id')
    .single()
  if (error) return { ok: false, error: error.message }
  return { ok: true, id: data.id as string }
}
