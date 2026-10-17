// Applications → CSV: readable in Excel (BOM), every column, safe quoting.
import { expect, test } from 'vitest'
import { applicationsCsv, CSV_COLUMNS } from './export-csv'
import type { DbApplication } from './store/types'

const base = {
  user_id: 'local', team: null, salary: null, location: null, remote: null, next_step: null, source: null, job_id: null,
  portal_application_url: null, notes: null, referral: false, starred: false, interviews: [], deadline: null, applied_at: null,
} as const

test('one row per application, newest activity first, quoted where needed', () => {
  const apps = [
    { ...base, id: 'a', company_id: 'bd', role: '财务AI产品经理（CIS-Finance）', stage: 'interview', applied_at: '2026-09-15T12:00:00Z',
      last_activity_at: '2026-10-14T09:00:00Z', created_at: '2026-09-15T12:00:00Z', location: '香港',
      interviews: [
        { round: 2, format: 'remote', interviewers: ['leader'], at: '2026-10-18T20:00:00Z', note: null },
        { round: 1, format: 'remote', interviewers: ['peer', 'hr'], at: '2026-09-21T19:00:00Z', note: 'went well' },
      ],
      notes: 'Referral from "Kai", follow up\nafter round 2' },
    { ...base, id: 'b', company_id: 'acme', role: 'PM, Growth', stage: 'saved', last_activity_at: '2026-10-01T00:00:00Z',
      created_at: '2026-10-01T00:00:00Z', portal_application_url: 'https://jobs.lever.co/acme/1', referral: true, deadline: '2026-10-25' },
  ] as unknown as DbApplication[]
  const csv = applicationsCsv(apps, [{ id: 'bd', name: '字节跳动' }, { id: 'acme', name: 'Acme, Inc.' }])
  expect(csv.startsWith('﻿')).toBe(true)
  const lines = csv.slice(1).split('\r\n')
  expect(lines[0]).toBe(CSV_COLUMNS.join(','))
  expect(lines[1]).toMatch(/^字节跳动,财务AI产品经理（CIS-Finance）,Interview,2026-09-15,香港,/)
  expect(lines[1]).toContain('Round 1 · Remote · Peer + HR · 2026-09-')
  expect(lines[1].indexOf('Round 1')).toBeLessThan(lines[1].indexOf('Round 2'))
  expect(csv).toContain('"Referral from ""Kai"", follow up\nafter round 2"')
  expect(csv).toContain('"Acme, Inc.","PM, Growth",Lead (not applied),,,,,,,Yes,https://jobs.lever.co/acme/1,2026-10-25')
})
