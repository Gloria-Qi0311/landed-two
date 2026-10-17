// Applications as a spreadsheet (CSV): one row per application, readable in
// Excel, Numbers or Google Sheets. The full backup (every table, JSON) is
// the account menu's Export backup; this is the human-readable one.
import { sortRounds } from '@landed/schema/pipeline'
import type { DbApplication } from './store/types'

const STAGE: Record<string, string> = {
  saved: 'Lead (not applied)', applied: 'Applied', oa: 'OA / Test', interview: 'Interview', offer: 'Offer',
  rejected: 'Rejected', ghosted: 'Ghosted', phone: 'Interview', onsite: 'Interview',
}
const FORMAT: Record<string, string> = { onsite: 'Onsite', remote: 'Remote' }
const WHO: Record<string, string> = { peer: 'Peer', teammate: 'Teammate', leader: 'Leader', hr: 'HR' }

const pad = (n: number) => String(n).padStart(2, '0')
const day = (iso: string | null | undefined) => {
  if (!iso || Number.isNaN(Date.parse(iso))) return ''
  const d = new Date(iso)
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}
const time = (iso: string | null | undefined) => {
  if (!iso || Number.isNaN(Date.parse(iso))) return ''
  const d = new Date(iso)
  return `${day(iso)} ${pad(d.getHours())}:${pad(d.getMinutes())}`
}

/** "a,b" → "\"a,b\""; quotes doubled; line breaks kept inside quotes. */
function cell(value: unknown): string {
  const s = value === null || value === undefined ? '' : String(value)
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
}

export const CSV_COLUMNS = [
  'Company', 'Role', 'Stage', 'Applied on', 'Location', 'Remote', 'Salary', 'Team', 'Source', 'Referral', 'Job link',
  'Apply by', 'Next step', 'Interviews', 'Notes', 'Last activity', 'Added',
] as const

export function applicationsCsv(apps: DbApplication[], companies: { id: string; name: string }[]): string {
  const name = new Map(companies.map((c) => [c.id, c.name]))
  const rows = [...apps]
    .sort((a, b) => (b.last_activity_at ?? '').localeCompare(a.last_activity_at ?? ''))
    .map((a) => [
      name.get(a.company_id) ?? '',
      a.role,
      STAGE[a.stage] ?? a.stage,
      day(a.applied_at),
      a.location,
      a.remote,
      a.salary,
      a.team,
      a.source,
      a.referral ? 'Yes' : '',
      a.portal_application_url,
      a.deadline,
      a.next_step,
      sortRounds(a.interviews ?? []).map((r) => [
        r.round ? `Round ${r.round}` : 'Interview',
        r.format ? FORMAT[r.format] : null,
        r.interviewers?.length ? r.interviewers.map((i) => WHO[i] ?? i).join(' + ') : null,
        r.at ? time(r.at) : null,
        r.note,
      ].filter(Boolean).join(' · ')).join('; '),
      a.notes,
      day(a.last_activity_at),
      day(a.created_at),
    ])
  // The BOM tells Excel it's UTF-8, so Chinese names come through.
  return '﻿' + [CSV_COLUMNS as readonly string[], ...rows].map((r) => r.map(cell).join(',')).join('\r\n') + '\r\n'
}
