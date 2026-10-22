// Applications from a spreadsheet: a CSV file, or cells copied from Excel,
// Numbers or Google Sheets and pasted. Everything here runs in the browser,
// like the export (lib/export-csv.ts). The steps:
//   readTable → guessMapping (the user can change it) → readRows → planImport
//   (new, already in Landed, or a further stage for one that is) → runImport.
// Never merges and never moves a stage backwards or reopens a closed one;
// password columns are never read.
import { applicationForPosting, companyKey } from '@landed/observation-processor'
import { parseDeadline, type StageValue } from '@landed/schema/pipeline'
import { samePosting } from './duplicates'
import type { ApplicationInput, DataStore, DbApplication, DbCompany, DbJobLead } from './store/types'

// ── reading the file ──────────────────────────────────────────────────────

/** UTF-8 (with or without a BOM); else GB18030, which is what Excel on a
 *  Chinese Windows saves a CSV as. */
export function decodeBytes(bytes: ArrayBuffer | Uint8Array): string {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes).replace(/^﻿/, '')
  } catch {
    return new TextDecoder('gb18030').decode(bytes)
  }
}

/** Rows of cells. Tabs (pasted cells), commas or semicolons (Excel in some
 *  countries), whichever the first line uses; quoted cells may hold
 *  separators, doubled quotes and line breaks. Blank rows are dropped, and
 *  each row keeps its line number in the sheet. */
export function readTable(text: string): { line: number; cells: string[] }[] {
  const first = text.split(/\r?\n/).find((l) => l.trim()) ?? ''
  const outside = first.replace(/"[^"]*"/g, '')
  const sep = outside.includes('\t') ? '\t'
    : (outside.match(/;/g)?.length ?? 0) > (outside.match(/,/g)?.length ?? 0) ? ';' : ','
  const rows: { line: number; cells: string[] }[] = []
  let cells: string[] = []
  let cell = ''
  let quoted = false
  let line = 1
  let rowLine = 1
  const endRow = () => {
    cells.push(cell)
    if (cells.some((c) => c.trim())) rows.push({ line: rowLine, cells: cells.map((c) => c.trim()) })
    cells = []
    cell = ''
  }
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]
    if (quoted) {
      if (ch === '"' && text[i + 1] === '"') { cell += '"'; i++ }
      else if (ch === '"') quoted = false
      else { if (ch === '\n') line++; cell += ch }
    } else if (ch === '"' && !cell.trim()) { quoted = true; cell = '' }
    else if (ch === sep) { cells.push(cell); cell = '' }
    else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i++
      endRow()
      line++
      rowLine = line
    } else cell += ch
  }
  if (cell || cells.length) endRow()
  return rows
}

// ── columns ───────────────────────────────────────────────────────────────

export const IMPORT_FIELDS = [
  'company', 'role', 'stage', 'applied_at', 'job_url', 'location', 'remote', 'salary', 'team', 'source', 'referral',
  'deadline', 'next_step', 'notes',
] as const
export type ImportField = typeof IMPORT_FIELDS[number]
/** What a column becomes: a field, nothing, or (password columns) never read. */
export type ColumnUse = ImportField | 'skip' | 'secret'

export const FIELD_LABEL: Record<ImportField, string> = {
  company: 'Company', role: 'Role', stage: 'Status', applied_at: 'Applied on', job_url: 'Job link', location: 'Location',
  remote: 'Remote / on-site', salary: 'Salary', team: 'Team', source: 'Source', referral: 'Referral', deadline: 'Apply by',
  next_step: 'Next step', notes: 'Notes',
}

const SECRET = /password|passwd|passcode|pwd|密码|口令/i
// First match wins, so the more specific names come first ("job link" before
// "job", "application status" before "application date").
const HEADER_RULES: [ImportField | 'skip', RegExp][] = [
  ['skip', /^(id|no|number|index|序号|编号)$|jobid|reqid|requisition|^#$/],
  ['notes', /linkedin|contact|recruiter|联系/],
  ['job_url', /link|url|网址|链接|网申地址|投递地址/],
  ['deadline', /deadline|applyby|duedate|^due$|closing|截止/],
  ['stage', /status|stage|progress|result|outcome|状态|进度|进展|结果|阶段/],
  ['applied_at', /^applied(on)?$|appl.*(date|on|time)|(date|time).*appl|submitted|投递(日期|时间)|申请(日期|时间)|网申(日期|时间)|^date$|^日期$|^时间$|投递日|申请日/],
  ['next_step', /nextstep|next|todo|followup|下一步|待办|跟进/],
  ['referral', /referr|内推|推荐/],
  ['company', /company|employer|organi[sz]ation|^org$|firm|公司|企业|单位|雇主/],
  ['location', /location|city|place|office|^base$|地点|城市|工作地|地区|base地/],
  ['role', /role|position|title|job|opening|职位|岗位|职务/],
  ['remote', /remote|onsite|worktype|workmode|办公方式|远程/],
  ['salary', /salary|pay|compensation|comp$|wage|薪资|薪水|薪酬|待遇|工资/],
  ['team', /team|department|dept|division|部门|团队/],
  ['source', /source|channel|platform|via|渠道|来源|平台/],
  ['notes', /note|comment|remark|memo|interview|round|备注|笔记|说明|面试|轮/],
]

const headerKey = (h: string) => h.normalize('NFKC').toLowerCase().replace(/[\s_\-/:：()（）.#*]/g, '')

/** What each column probably is. A field goes to its first column. A column
 *  Landed has no place for (priority, type…) or a field seen again goes into
 *  notes ("Priority: high"), so nothing in the sheet is lost; only row
 *  numbers, ids and blank headers are left out, and passwords never read.
 *  `unknown: 'skip'` is for telling the header row apart from data. */
export function guessMapping(header: string[], unknown: 'notes' | 'skip' = 'notes'): ColumnUse[] {
  const taken = new Set<ImportField>()
  return header.map((h) => {
    if (SECRET.test(h)) return 'secret'
    const key = headerKey(h)
    if (!key) return 'skip'
    const field = HEADER_RULES.find(([, re]) => re.test(key))?.[0]
    if (field === 'skip') return 'skip'
    if (!field) return unknown
    if (taken.has(field)) return 'notes'
    taken.add(field)
    return field
  })
}

/** The header row: of the first ten, the one most columns are recognized in
 *  (a title row or a blank line above it is skipped); else the first. */
export function findHeader(rows: { cells: string[] }[]): number {
  let best = 0
  let bestScore = 1
  rows.slice(0, 10).forEach((r, i) => {
    const uses = guessMapping(r.cells, 'skip')
    const score = uses.filter((u) => u !== 'skip' && u !== 'secret').length
    if (score > bestScore && (uses.includes('company') || uses.includes('role'))) { best = i; bestScore = score }
  })
  return best
}

// ── values ────────────────────────────────────────────────────────────────

/** Not applied yet: "待申请", "还没投", "计划网申", "Not yet applied", "Haven't
 *  applied", "Will apply", "To do", "Not started", "Wishlist"… */
const NOT_YET = new RegExp([
  '(待|未|没|还没|尚未|准备|计划|打算|想|要|将)(去)?(投递|投|申请|网申)',
  '未开始|没开始|待定|收藏',
  "\\b(not|never|yet to|to|will|plan(ning)? to|going to|need to|want to|have ?n[o']?t|has ?n[o']?t|did ?n[o']?t)\\b[a-z\\s']{0,12}appl",
  '\\bnot (yet )?(started|submitted|sent)\\b',
  '\\b(to ?do|backlog|wish ?list|wish|draft|planning|saved|bookmark(ed)?|interested)\\b',
].join('|'))

export type StageGuess = { stage: StageValue; sure: boolean; note?: string }

/** A status as people write it, in English or Chinese, to a Landed stage.
 *  Finality first: "rejected after OA" is rejected. Withdrawn and a turned-
 *  down offer are closed (Landed has no stage for them) with a note. Not
 *  applied yet ("待申请", "未投", "Not yet applied", "To do") is a lead, read
 *  before the words for applied, which it contains. A blank status is Applied
 *  (it's an applications sheet); one Landed can't read is flagged for the
 *  user, and readRows decides it by the applied date. */
export function parseStage(raw: string): StageGuess {
  const t = raw.normalize('NFKC').toLowerCase().trim()
  if (!t) return { stage: 'applied', sure: true }
  if (/offer/.test(t) && /declin|turn(ed)? down|拒|不去|放弃|没接/.test(t)) return { stage: 'rejected', sure: true, note: 'Turned down the offer' }
  if (/withdr|放弃|撤回|撤销|主动|no longer interested|not interested/.test(t)) return { stage: 'rejected', sure: true, note: 'Withdrew' }
  if (/ghost|no (response|reply|news)|never heard|没回|无回|没消息|无消息|未回复|石沉大海|没下文/.test(t)) return { stage: 'ghosted', sure: true }
  if (/reject|declin|unsuccessful|not (selected|moving|proceed)|fail|\bding|拒|挂|未通过|没过|不合适|感谢信|淘汰|落选|失败/.test(t)) return { stage: 'rejected', sure: true }
  if (/offer|\boc\b|accepted|录用|意向|签约|签了|入职/.test(t)) return { stage: 'offer', sure: true }
  if (/interview|onsite|on-site|phone|(recruiter|hr|initial) ?screen|superday|final round|\bvo\b|\bhr\b|面|轮/.test(t)) return { stage: 'interview', sure: true }
  if (/\boa\b|assessment|test|hackerrank|codesignal|codility|challenge|take[- ]?home|笔试|测评|测试|作业/.test(t)) return { stage: 'oa', sure: true }
  if (NOT_YET.test(t)) return { stage: 'saved', sure: true }
  if (/appl|submit|sent|pending|review|waiting|in progress|投|网申|申请|审核|筛选|处理中|等待|已提交/.test(t)) return { stage: 'applied', sure: true }
  return { stage: 'applied', sure: false }
}

const pad = (n: number) => String(n).padStart(2, '0')
function ymd(y: number, m: number, d: number): string | null {
  const date = new Date(y, m - 1, d)
  if (y < 2000 || y > 2100 || date.getMonth() !== m - 1 || date.getDate() !== d) return null
  return `${y}-${pad(m)}-${pad(d)}`
}

/** A day that has passed ("YYYY-MM-DD"): 2026-09-15, 2026/9/15, 2026年9月15日,
 *  9/15/2026 (or 15/9/2026 when the first number can't be a month), 9/15 or
 *  9月15日 (this year, or last year if that's still to come), "Sep 15",
 *  Excel's day numbers (45915). Anything else is null: never guessed. */
export function parseDay(raw: string, now = new Date()): string | null {
  const t = raw.normalize('NFKC').trim()
  if (!t) return null
  if (/^\d{5}(\.\d+)?$/.test(t)) {
    const n = Math.floor(Number(t))
    if (n < 36526 || n > 73050) return null // 2000–2100
    const d = new Date(Date.UTC(1899, 11, 30) + n * 86_400_000)
    return ymd(d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDate())
  }
  let m = t.match(/^(\d{4})\s*[-/.年]\s*(\d{1,2})\s*[-/.月]\s*(\d{1,2})/)
  if (m) return ymd(+m[1], +m[2], +m[3])
  m = t.match(/^(\d{1,2})[-/.](\d{1,2})[-/.](\d{2}|\d{4})\b/)
  if (m) {
    const y = m[3].length === 2 ? 2000 + +m[3] : +m[3]
    return +m[1] > 12 ? ymd(y, +m[2], +m[1]) : ymd(y, +m[1], +m[2])
  }
  const thisYear = (mo: number, d: number) => {
    const day = ymd(now.getFullYear(), mo, d)
    // Applied dates are in the past: a date still to come (by more than a week) was last year.
    if (day && Date.parse(day) - now.getTime() > 7 * 86_400_000) return ymd(now.getFullYear() - 1, mo, d)
    return day
  }
  m = t.match(/^(\d{1,2})\s*[/.月-]\s*(\d{1,2})\s*日?$/)
  if (m) return thisYear(+m[1], +m[2])
  // Otherwise only a month name and a day: "Sep 15", "15 September 2026".
  if (!/\b(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?\s/i.test(`${t} `) || !/\b\d{1,2}\b/.test(t)) return null
  if (/\b\d{4}\b/.test(t)) return parseDeadline(t)
  const ms = Date.parse(`${t} ${now.getFullYear()}`)
  if (Number.isNaN(ms)) return null
  const d = new Date(ms)
  return thisYear(d.getMonth() + 1, d.getDate())
}

const YES = /^(y|yes|true|是|有|对|✓|✔|√|x|1)$/i
const NO = /^(n|no|false|否|无|没有|不是|-|—|0|n\/a|na)$/i

function linkIn(raw: string): string | null {
  const url = raw.match(/https?:\/\/\S+/i)?.[0] ?? (/^www\.\S+\.\S+/i.test(raw) ? `https://${raw.split(/\s/)[0]}` : null)
  return url ? url.replace(/[)\]>,，。]+$/, '') : null
}

function remoteOf(raw: string): string | null {
  if (/hybrid|混合/i.test(raw)) return 'Hybrid'
  if (/remote|远程|居家/i.test(raw)) return 'Remote'
  if (/on-?site|in[- ]?office|in person|现场|线下|坐班/i.test(raw)) return 'On-site'
  return null
}

// ── rows ──────────────────────────────────────────────────────────────────

export type ImportRow = {
  /** the row's line in the sheet */
  line: number
  company: string
  role: string
  stage: StageValue
  /** false: the status wasn't one Landed knows (shown so the user can pick) */
  stageSure: boolean
  /** the status as written */
  status: string
  application: Omit<ApplicationInput, 'role' | 'stage'>
  /** why it can't be imported */
  problem?: 'no company' | 'no role'
}

/** The sheet's data rows (after the header) as applications. Notes collect
 *  every notes-like column ("Header: value" when there are several), the
 *  referrer's name and the withdrawn / turned-down note. */
export function readRows(
  table: { line: number; cells: string[] }[], headerIndex: number, mapping: ColumnUse[], now = new Date(),
  stageOf: (status: string) => StageGuess = parseStage,
): ImportRow[] {
  const header = table[headerIndex]?.cells ?? []
  const notesCols = mapping.filter((u) => u === 'notes').length
  return table.slice(headerIndex + 1).map(({ line, cells }) => {
    const value = (f: ImportField) => {
      const i = mapping.indexOf(f)
      return i < 0 ? '' : (cells[i] ?? '').trim()
    }
    const read = stageOf(value('stage'))
    // A status Landed can't read: Applied if the row says when, else a lead.
    const guess = read.sure ? read : { ...read, stage: parseDay(value('applied_at'), now) ? 'applied' as const : 'saved' as const }
    const notes: string[] = []
    mapping.forEach((u, i) => {
      const v = (cells[i] ?? '').trim()
      if (u === 'notes' && v) notes.push(notesCols > 1 && header[i] ? `${header[i]}: ${v}` : v)
    })
    const referral = value('referral')
    if (referral && !YES.test(referral) && !NO.test(referral)) notes.push(`Referral: ${referral}`)
    if (guess.note) notes.push(guess.note)
    const applied = guess.stage === 'saved' ? null : parseDay(value('applied_at'), now)
    const [y, mo, d] = (applied ?? '').split('-').map(Number)
    const company = value('company')
    const role = value('role')
    return {
      line,
      company,
      role,
      stage: guess.stage,
      stageSure: guess.sure,
      status: value('stage'),
      application: {
        // Noon local time, so the day doesn't shift in another time zone.
        applied_at: applied ? new Date(y, mo - 1, d, 12).toISOString() : null,
        portal_application_url: linkIn(value('job_url')),
        location: value('location') || null,
        // A sheet often keeps both in one column ("上海 · 线下", "Seattle (Hybrid)").
        remote: remoteOf(value('remote')) ?? remoteOf(value('location')),
        salary: value('salary') || null,
        team: value('team') || null,
        source: value('source') || null,
        referral: !!referral && !NO.test(referral),
        deadline: parseDeadline(value('deadline')),
        next_step: value('next_step') || null,
        notes: notes.join('\n') || null,
      },
      ...(!company ? { problem: 'no company' as const } : !role ? { problem: 'no role' as const } : {}),
    }
  })
}

// ── the statuses: the rules when they're sure, else the user's agent ──────
// People write statuses their own way ("先放着", "回头投", "等消息中"). The
// rules read the usual ones; the statuses they can't read (only those words,
// never a company, role or note) go to the user's own agent (extension →
// Landed for Mac → classify_statuses), which reads what they mean. The
// preview lists every status with its stage and who read it; the user's pick
// wins over both.

/** What the agent said, by status. */
export type AgentStages = Record<string, { stage: string; note: string | null }>
export type StatusReading = StageGuess & { by: 'rules' | 'agent' | 'you' | null }

const AGENT_NOTE: Record<string, string> = { withdrew: 'Withdrew', declined_offer: 'Turned down the offer' }
const AGENT_STAGES: readonly string[] = ['saved', 'applied', 'oa', 'interview', 'offer', 'rejected', 'ghosted']

/** The statuses the rules can't read: the ones to ask the agent about. */
export function unreadStatuses(rows: ImportRow[]): string[] {
  return [...new Set(rows.map((r) => r.status).filter((t) => t && !parseStage(t).sure))].slice(0, 40)
}

/** One status: the user's pick, else the rules when sure, else the agent's
 *  stage, else not sure. */
export function readStatus(status: string, agent: AgentStages | null, yours: Record<string, StageValue> = {}): StatusReading {
  const rules = parseStage(status)
  if (yours[status]) return { stage: yours[status], sure: true, by: 'you', ...(rules.note && yours[status] === rules.stage ? { note: rules.note } : {}) }
  if (rules.sure) return { ...rules, by: 'rules' }
  const a = agent?.[status]
  if (a && AGENT_STAGES.includes(a.stage)) {
    return { stage: a.stage as StageValue, sure: true, by: 'agent', ...(a.note && AGENT_NOTE[a.note] ? { note: AGENT_NOTE[a.note] } : {}) }
  }
  return { ...rules, by: null }
}

// ── against what's already in Landed ──────────────────────────────────────

const RANK: Record<string, number> = { saved: 0, applied: 1, oa: 2, interview: 3, phone: 3, onsite: 3, offer: 4, rejected: 5, ghosted: 5 }
/** Further along: never backwards; closed is furthest, so a closed one is never reopened. */
export const isForward = (from: string, to: string) => (RANK[to] ?? 0) > (RANK[from] ?? 0)

export type Planned = ImportRow & {
  /** add a new application, move an existing one forward, or leave it */
  action: 'add' | 'update' | 'skip'
  /** the application already in Landed (update, or skip as a duplicate) */
  existing?: { id: string; role: string; stage: string }
  /** an update back to Leads: the sheet says not applied yet, and Landed has
   *  it as Applied with no applied date (an earlier import read it wrong) */
  back?: boolean
  reason?: 'in Landed' | 'twice in the sheet' | 'no company' | 'no role'
}

/** Each row: new, already in Landed (the same posting link, or a nearly
 *  identical role at the same employer: the duplicate rule), or a further
 *  stage of one that is. A row twice in the sheet is added once, at the
 *  furthest stage. A new row takes the spelling of a company already in
 *  Landed (蚂蚁集团 / 蚂蚁 are one), so no second company appears. */
export function planImport(rows: ImportRow[], apps: DbApplication[], companies: DbCompany[]): Planned[] {
  const keyOf = new Map(companies.map((c) => [c.id, companyKey(c.name)]))
  const nameFor = new Map<string, string>()
  for (const c of companies) if (!nameFor.has(companyKey(c.name))) nameFor.set(companyKey(c.name), c.name)
  const posting = (r: ImportRow) => ({ id: '', company_id: '', role: r.role, portal_application_url: r.application.portal_application_url ?? null })
  const added: Planned[] = []
  return rows.map((r): Planned => {
    if (r.problem) return { ...r, action: 'skip', reason: r.problem }
    const key = companyKey(r.company)
    const company = nameFor.get(key) ?? r.company
    if (!nameFor.has(key)) nameFor.set(key, r.company)
    const existing = apps.find((a) => keyOf.get(a.company_id) === key && samePosting(a, posting(r)))
    if (existing) {
      const e = { id: existing.id, role: existing.role, stage: existing.stage }
      if (isForward(existing.stage, r.stage)) return { ...r, company, action: 'update', existing: e }
      // Never backwards, but one correction: Applied with no date, and the
      // sheet plainly says not applied yet.
      if (existing.stage === 'applied' && !existing.applied_at && r.stage === 'saved' && r.stageSure) return { ...r, company, action: 'update', existing: e, back: true }
      return { ...r, company, action: 'skip', existing: e, reason: 'in Landed' }
    }
    const twin = added.find((p) => companyKey(p.company) === key && samePosting(posting(p), posting(r)))
    if (twin) {
      if (isForward(twin.stage, r.stage)) Object.assign(twin, { stage: r.stage, stageSure: r.stageSure, status: r.status })
      return { ...r, company, action: 'skip', reason: 'twice in the sheet' }
    }
    const p: Planned = { ...r, company, action: 'add' }
    added.push(p)
    return p
  })
}

// ── writing ───────────────────────────────────────────────────────────────

const BATCH = 200

export type ImportOutcome = {
  added: string[]
  /** moved forward: id and the stage it had */
  updated: { id: string; from: string }[]
  /** leads already found for these jobs, now marked applied (or, for one
   *  moved back to Leads, unmarked): id, their status and application before */
  leads: { id: string; from: DbJobLead['status']; app?: string | null }[]
  /** the earliest applied date among the rows (YYYY-MM-DD), for reading email back that far */
  earliest: string | null
}

/** Adds the new rows (in batches), moves the chosen ones forward, and marks
 *  leads found earlier for these jobs as applied, so they leave Leads and a
 *  search doesn't bring them back. Imported applications count as news today,
 *  so the 21-day "still waiting?" questions don't all arrive at once. */
export async function runImport(store: DataStore, rows: Planned[]): Promise<ImportOutcome> {
  const adds = rows.filter((r) => r.action === 'add')
  const added: DbApplication[] = []
  for (let i = 0; i < adds.length; i += BATCH) {
    const res = await store.importApplications({
      applications: adds.slice(i, i + BATCH).map((r) => ({ ...r.application, company_name: r.company, role: r.role, stage: r.stage })),
    })
    added.push(...res.applications)
  }
  const updated: ImportOutcome['updated'] = []
  for (const r of rows) {
    if (r.action !== 'update' || !r.existing) continue
    await store.updateApplication(r.existing.id, { stage: r.stage })
    updated.push({ id: r.existing.id, from: r.existing.stage })
  }
  const [apps, companies, leads] = await Promise.all([store.listApplications(), store.listCompanies(), store.listJobLeads()])
  // One moved back to Leads: a lead an earlier import marked applied for it
  // is a lead again.
  const back = new Set(rows.filter((r) => r.action === 'update' && r.back && r.existing).map((r) => r.existing!.id))
  const unmarked: ImportOutcome['leads'] = []
  for (const lead of leads) {
    if (lead.status !== 'already_applied' || !lead.application_id || !back.has(lead.application_id)) continue
    await store.updateJobLead(lead.id, { status: 'new', application_id: null })
    unmarked.push({ id: lead.id, from: lead.status, app: lead.application_id })
    lead.status = 'new'
  }
  const touched = new Set([...added.map((a) => a.id), ...updated.filter((u) => !back.has(u.id)).map((u) => u.id)])
  const mine = apps.filter((a) => touched.has(a.id))
  const marked: ImportOutcome['leads'] = [...unmarked]
  for (const lead of leads) {
    if (lead.status !== 'new') continue
    const app = applicationForPosting(lead, mine, companies)
    if (!app || app.stage === 'saved') continue
    await store.updateJobLead(lead.id, { status: 'already_applied', application_id: app.id })
    marked.push({ id: lead.id, from: lead.status, app: null })
  }
  const days = rows.filter((r) => r.action !== 'skip').map((r) => r.application.applied_at?.slice(0, 10)).filter((d): d is string => !!d).sort()
  return { added: added.map((a) => a.id), updated, leads: marked, earliest: days[0] ?? null }
}

/** Puts everything back: leads first (deleting an application only unlinks
 *  them), then the stages, then the new applications. */
export async function undoImport(store: DataStore, outcome: ImportOutcome): Promise<void> {
  for (const l of outcome.leads) await store.updateJobLead(l.id, { status: l.from, application_id: l.app ?? null })
  for (const u of outcome.updated) await store.updateApplication(u.id, { stage: u.from as StageValue })
  for (const id of outcome.added) await store.deleteApplication(id)
}

