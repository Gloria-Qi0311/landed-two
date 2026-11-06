import 'fake-indexeddb/auto'
import { describe, expect, test } from 'vitest'
import { ingestFoundJobs } from './inbox'
import {
  decodeBytes, findHeader, guessMapping, isForward, parseDay, parseStage, planImport, readRows, readStatus, readTable, runImport, undoImport, unreadStatuses, emailAfterImport,
} from './import-applications'
import { createLocalStore } from './store/local'

let n = 0
const fresh = () => createLocalStore(`landed-import-${++n}`)
const NOW = new Date(2026, 9, 20, 9) // Oct 20, 2026

const rowsOf = (text: string) => {
  const table = readTable(text)
  const h = findHeader(table)
  return readRows(table, h, guessMapping(table[h].cells), NOW)
}

describe('reading the sheet', () => {
  test('commas, quotes with commas, doubled quotes and line breaks; blank rows dropped with line numbers kept', () => {
    const t = readTable('Company,Role,Notes\r\n"Kestrel Pay, Inc.",Analyst,"said ""soon""\nthen nothing"\r\n,,\r\nNorthwind Robotics,PM,\r\n')
    expect(t).toEqual([
      { line: 1, cells: ['Company', 'Role', 'Notes'] },
      { line: 2, cells: ['Kestrel Pay, Inc.', 'Analyst', 'said "soon"\nthen nothing'] },
      { line: 5, cells: ['Northwind Robotics', 'PM', ''] },
    ])
  })

  test('cells pasted from a spreadsheet (tabs) and semicolon CSVs', () => {
    expect(readTable('公司\t职位\n蓝鲸科技\t产品经理')[1].cells).toEqual(['蓝鲸科技', '产品经理'])
    expect(readTable('Company;Role;Salary\nBluefin Analytics;Analyst;"90,000"')[1].cells).toEqual(['Bluefin Analytics', 'Analyst', '90,000'])
  })

  test('UTF-8 with a BOM, and GB18030 from Excel on a Chinese Windows', () => {
    const utf8 = new Uint8Array([0xef, 0xbb, 0xbf, ...new TextEncoder().encode('公司,职位')])
    expect(decodeBytes(utf8)).toBe('公司,职位')
    // "公司" in GB18030
    expect(decodeBytes(new Uint8Array([0xb9, 0xab, 0xcb, 0xbe]))).toBe('公司')
  })

  test('the header row is found under a title row', () => {
    const t = readTable('My fall applications 2026\n\nCompany,Position,Status\nKestrel Pay,Analyst,Applied')
    expect(findHeader(t)).toBe(1)
  })
})

describe('columns', () => {
  test('English and Chinese headers; a password column is never read', () => {
    expect(guessMapping(['Company Name', 'Job Title', 'Application Status', 'Date Applied', 'Job Link', 'Location', 'Referral', 'Notes', 'Portal Password']))
      .toEqual(['company', 'role', 'stage', 'applied_at', 'job_url', 'location', 'referral', 'notes', 'secret'])
    expect(guessMapping(['公司', '岗位', '进度', '投递时间', '网申链接', '工作地点', '内推', '备注', '密码']))
      .toEqual(['company', 'role', 'stage', 'applied_at', 'job_url', 'location', 'referral', 'notes', 'secret'])
  })

  test('a column Landed has no place for goes into notes, so nothing is lost', () => {
    expect(guessMapping(['优先级', '公司', '职位', '类型', '入职时间', '序号', '']))
      .toEqual(['notes', 'company', 'role', 'notes', 'notes', 'skip', 'skip'])
    const [row] = rowsOf('优先级,公司,职位,类型,地点/形式\n高,蓝鲸科技,产品经理,实习,上海 · 线下')
    expect(row.application.notes).toBe('优先级: 高\n类型: 实习')
    expect(row.application).toMatchObject({ location: '上海 · 线下', remote: 'On-site' })
  })

  test('traps: LinkedIn is not the job link, Job ID is not the role, a second notes column adds to notes', () => {
    expect(guessMapping(['Job ID', 'Company', 'Role', 'Recruiter LinkedIn', 'Interview rounds', 'Comments', 'Deadline']))
      .toEqual(['skip', 'company', 'role', 'notes', 'notes', 'notes', 'deadline'])
  })
})

describe('values', () => {
  test.each([
    ['Applied', 'applied'], ['已投递', 'applied'], ['Under review', 'applied'], ['Pending', 'applied'],
    ['OA received', 'oa'], ['笔试', 'oa'], ['HackerRank', 'oa'],
    ['Phone screen', 'interview'], ['一面', 'interview'], ['HR面', 'interview'], ['Final round', 'interview'],
    ['Offer!', 'offer'], ['OC', 'offer'], ['意向书', 'offer'],
    ['Rejected after OA', 'rejected'], ['挂了', 'rejected'], ['感谢信', 'rejected'],
    ['No response', 'ghosted'], ['石沉大海', 'ghosted'],
    ['Wishlist', 'saved'], ['未投', 'saved'], ['', 'applied'],
    // Not applied yet, though it says "apply" / "申请" (a user's sheet had 31 "待申请" rows go to Applied).
    ['待申请', 'saved'], ['未申请', 'saved'], ['准备申请', 'saved'], ['还没投', 'saved'], ['计划网申', 'saved'], ['未开始', 'saved'],
    ['Not yet applied', 'saved'], ["Haven't applied", 'saved'], ['Will apply', 'saved'], ['To do', 'saved'], ['Not started', 'saved'],
    ['已申请', 'applied'], ['申请中', 'applied'], ['Applied to Google', 'applied'], ['待面试', 'interview'], ['待笔试', 'oa'],
  ])('%s → %s', (raw, stage) => {
    expect(parseStage(raw)).toMatchObject({ stage, sure: true })
  })

  test('an unknown status is flagged; the row\'s applied date decides it: a date is Applied, none is a lead', () => {
    const [dated, undated] = rowsOf(['Company,Role,Status,Applied', 'Kestrel Pay,Analyst,🤞,9/15', 'Bluefin Analytics,Analyst,🤞,'].join('\n'))
    expect(dated).toMatchObject({ stage: 'applied', stageSure: false })
    expect(undated).toMatchObject({ stage: 'saved', stageSure: false })
  })

  test('withdrawn and a turned-down offer are closed with a note; an unknown status is flagged', () => {
    expect(parseStage('Withdrew')).toEqual({ stage: 'rejected', sure: true, note: 'Withdrew' })
    expect(parseStage('拒了offer')).toEqual({ stage: 'rejected', sure: true, note: 'Turned down the offer' })
    expect(parseStage('Offer declined')).toEqual({ stage: 'rejected', sure: true, note: 'Turned down the offer' })
    expect(parseStage('🤞')).toEqual({ stage: 'applied', sure: false })
  })

  test('applied dates in the ways people write them; never guessed', () => {
    expect(parseDay('2026-09-15', NOW)).toBe('2026-09-15')
    expect(parseDay('2026/9/5', NOW)).toBe('2026-09-05')
    expect(parseDay('2026年9月15日', NOW)).toBe('2026-09-15')
    expect(parseDay('9/15/2026', NOW)).toBe('2026-09-15')
    expect(parseDay('15/9/2026', NOW)).toBe('2026-09-15')
    expect(parseDay('9/15/26', NOW)).toBe('2026-09-15')
    expect(parseDay('9月15日', NOW)).toBe('2026-09-15')
    expect(parseDay('9/15', NOW)).toBe('2026-09-15')
    expect(parseDay('12/1', NOW)).toBe('2025-12-01') // still to come this year → last year
    expect(parseDay('Sep 15', NOW)).toBe('2026-09-15')
    expect(parseDay('15 September 2026', NOW)).toBe('2026-09-15')
    expect(parseDay('46280', NOW)).toBe('2026-09-15') // Excel's day number
    expect(parseDay('soon', NOW)).toBeNull()
    expect(parseDay('May', NOW)).toBeNull()
    expect(parseDay('15', NOW)).toBeNull()
    expect(parseDay('2/30/2026', NOW)).toBeNull()
  })

  test('a row: link pulled out, referrer kept in notes, remote read, no date for one not applied to', () => {
    const [a, b] = rowsOf([
      'Company,Role,Status,Date applied,Link,Work mode,Referral,Notes',
      'Kestrel Pay,Data Analyst,Interview,9/15,see https://boards.greenhouse.io/kestrel/jobs/123 (main),Remote,Jordan Lee,call went well',
      'Bluefin Analytics,Analyst,wishlist,9/20,,,no,',
    ].join('\n'))
    expect(a).toMatchObject({ line: 2, company: 'Kestrel Pay', role: 'Data Analyst', stage: 'interview', stageSure: true })
    expect(a.application).toMatchObject({
      portal_application_url: 'https://boards.greenhouse.io/kestrel/jobs/123', remote: 'Remote', referral: true,
      notes: 'call went well\nReferral: Jordan Lee',
    })
    expect(new Date(a.application.applied_at!).getDate()).toBe(15)
    expect(b).toMatchObject({ stage: 'saved' })
    expect(b.application).toMatchObject({ applied_at: null, referral: false })
  })

  test('rows without a company or a role are reported, not imported', () => {
    const rows = rowsOf('Company,Role\nKestrel Pay,\n,Analyst')
    expect(rows.map((r) => r.problem)).toEqual(['no role', 'no company'])
  })
})

describe('statuses the rules can\'t read go to the user\'s agent', () => {
  const sheet = ['Company,Role,Status,Applied', 'A Co,PM,待申请,', 'B Co,PM,先放着,', 'C Co,PM,先放着,', 'D Co,PM,不想去了,', 'E Co,PM,🤞,9/1', 'F Co,PM,一面,9/2'].join('\n')

  test('only the ones the rules can\'t read are asked about, once each', () => {
    expect(unreadStatuses(rowsOf(sheet))).toEqual(['先放着', '不想去了', '🤞'])
  })

  test('the rules when sure; else the agent; else not sure (the date decides); the user\'s pick over all', () => {
    const agent = { 先放着: { stage: 'saved', note: null }, 不想去了: { stage: 'rejected', note: 'withdrew' }, 一面: { stage: 'offer', note: null }, '🤞': { stage: 'hired', note: null } }
    expect(readStatus('一面', agent)).toMatchObject({ stage: 'interview', sure: true, by: 'rules' })
    expect(readStatus('先放着', agent)).toMatchObject({ stage: 'saved', sure: true, by: 'agent' })
    expect(readStatus('不想去了', agent)).toEqual({ stage: 'rejected', sure: true, by: 'agent', note: 'Withdrew' })
    expect(readStatus('🤞', agent)).toMatchObject({ sure: false, by: null })
    expect(readStatus('先放着', null, { 先放着: 'applied' })).toMatchObject({ stage: 'applied', by: 'you' })

    const rows = readRows(readTable(sheet), 0, guessMapping(readTable(sheet)[0].cells), NOW, (t) => readStatus(t, agent))
    expect(rows.map((r) => [r.company, r.stage, r.stageSure])).toEqual([
      ['A Co', 'saved', true], ['B Co', 'saved', true], ['C Co', 'saved', true], ['D Co', 'rejected', true],
      ['E Co', 'applied', false], ['F Co', 'interview', true],
    ])
    expect(rows[3].application.notes).toBe('Withdrew')
  })
})

describe('against Landed', () => {
  test('stages only move forward, and a closed one is never reopened', () => {
    expect(isForward('applied', 'interview')).toBe(true)
    expect(isForward('interview', 'rejected')).toBe(true)
    expect(isForward('interview', 'applied')).toBe(false)
    expect(isForward('rejected', 'offer')).toBe(false)
    expect(isForward('ghosted', 'rejected')).toBe(false)
  })

  test('new, already there, a further stage, twice in the sheet, and the company spelled as in Landed', async () => {
    const store = fresh()
    const kestrel = await store.addApplication({ name: 'Kestrel Pay Inc.' }, { role: 'Data Analyst', stage: 'applied' })
    await store.addApplication({ name: 'Northwind Robotics' }, { role: 'Product Manager', stage: 'interview' })
    const rows = rowsOf([
      'Company,Role,Status',
      'Kestrel Pay,Data Analyst,Interview', // further along → update
      'Northwind Robotics,Product Manager,Applied', // behind Landed → leave it
      'Kestrel Pay,Risk Analyst,Applied', // new, at a company Landed has
      'Bluefin Analytics,Analyst,Applied',
      'Bluefin Analytics,Analyst,OA', // twice: added once, at OA
    ].join('\n'))
    const plan = planImport(rows, await store.listApplications(), await store.listCompanies())
    expect(plan.map((p) => [p.action, p.reason ?? null])).toEqual([
      ['update', null], ['skip', 'in Landed'], ['add', null], ['add', null], ['skip', 'twice in the sheet'],
    ])
    expect(plan[0].existing?.id).toBe(kestrel.id)
    expect(plan[2].company).toBe('Kestrel Pay Inc.')
    expect(plan[3].stage).toBe('oa')
  })

  test('import, then undo: rows added, a stage moved, an earlier lead marked applied; undo puts it all back', async () => {
    const store = fresh()
    const kestrel = await store.addApplication({ name: 'Kestrel Pay' }, { role: 'Data Analyst', stage: 'applied' })
    await ingestFoundJobs(store, [{
      company: 'Bluefin Analytics', title: 'Software Engineer Intern', job_url: null,
      location: null, posted: null, deadline: null, salary: null, sponsorship: null, why: null,
    }], { run_id: 'job-1', runtime_id: 'mac', agent: 'claude' })
    const rows = rowsOf([
      'Company,Role,Status,Applied',
      'Kestrel Pay,Data Analyst,一面,9/1',
      'Bluefin Analytics,SDE Intern,Applied,8/20',
      'Lumen Labs,Designer,Applied,',
    ].join('\n'))
    const before = (await store.listApplications()).length
    const outcome = await runImport(store, planImport(rows, await store.listApplications(), await store.listCompanies()))
    expect(outcome.added).toHaveLength(2)
    expect(outcome.updated).toEqual([{ id: kestrel.id, from: 'applied' }])
    expect(outcome.earliest).toBe('2026-08-20')
    const [lead] = await store.listJobLeads()
    expect(lead.status).toBe('already_applied')
    // News today: the "still waiting?" questions start from now, not from August.
    const added = (await store.listApplications()).filter((a) => outcome.added.includes(a.id))
    expect(added.every((a) => Date.now() - Date.parse(a.last_activity_at) < 60_000)).toBe(true)
    expect((await store.listCompanies()).filter((c) => c.name === 'Kestrel Pay')).toHaveLength(1)

    await undoImport(store, outcome)
    const apps = await store.listApplications()
    expect(apps).toHaveLength(before)
    expect(apps.find((a) => a.id === kestrel.id)?.stage).toBe('applied')
    expect((await store.listJobLeads())[0]).toMatchObject({ status: 'new', application_id: null })
  })

  test('an earlier import that put not-applied jobs in Applied: importing again offers them back to Leads, and undo still works', async () => {
    const store = fresh()
    await ingestFoundJobs(store, [{
      company: 'Ultra Mobile', title: 'Product Management Intern', job_url: null,
      location: null, posted: null, deadline: null, salary: null, sponsorship: null, why: null,
    }], { run_id: 'job-1', runtime_id: 'mac', agent: 'claude' })
    // As the old reading did it: Applied with no date, and the lead marked applied.
    const wrong = rowsOf(['Company,Role,Status,Applied', 'Ultra Mobile,Product Management Intern,Applied,', 'Kestrel Pay,Data Analyst,Applied,9/1'].join('\n'))
    await runImport(store, planImport(wrong, await store.listApplications(), await store.listCompanies()))
    const ultra = (await store.listApplications()).find((a) => a.role === 'Product Management Intern')!
    expect((await store.listJobLeads())[0]).toMatchObject({ status: 'already_applied', application_id: ultra.id })

    const sheet = rowsOf(['Company,Role,Status,Applied', 'Ultra Mobile,Product Management Intern,待申请,', 'Kestrel Pay,Data Analyst,待申请,'].join('\n'))
    const plan = planImport(sheet, await store.listApplications(), await store.listCompanies())
    expect(plan[0]).toMatchObject({ action: 'update', back: true, stage: 'saved', existing: { id: ultra.id, stage: 'applied' } })
    // One Landed has an applied date for stays Applied: never moved back.
    expect(plan[1]).toMatchObject({ action: 'skip', reason: 'in Landed' })

    const outcome = await runImport(store, plan)
    expect((await store.listApplications()).find((a) => a.id === ultra.id)?.stage).toBe('saved')
    expect((await store.listJobLeads())[0]).toMatchObject({ status: 'new', application_id: null })

    await undoImport(store, outcome)
    expect((await store.listApplications()).find((a) => a.id === ultra.id)?.stage).toBe('applied')
    expect((await store.listJobLeads())[0]).toMatchObject({ status: 'already_applied', application_id: ultra.id })
  })
})

describe('after an import, email brings it up to date', () => {
  test('on its own only when Check email is on; once, on a click, when it is off; set up when no computer reads email', () => {
    expect(emailAfterImport({ changed: 32, canRead: true, enabled: true })).toBe('auto')
    // The user turned Check email off on Workflow: Landed never reads email on its own.
    expect(emailAfterImport({ changed: 32, canRead: true, enabled: false })).toBe('offer')
    expect(emailAfterImport({ changed: 32, canRead: false, enabled: true })).toBe('setup')
    expect(emailAfterImport({ changed: 32, canRead: false, enabled: false })).toBe('setup')
    expect(emailAfterImport({ changed: 0, canRead: true, enabled: true })).toBe('none')
  })
})
