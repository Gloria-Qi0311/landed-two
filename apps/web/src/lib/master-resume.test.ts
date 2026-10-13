// My Resume: master resume shape, flattening, and the store's rules.
import 'fake-indexeddb/auto'
import { describe, expect, test } from 'vitest'
import { safeNormalize } from '@landed/schema'
import { masterStats, masterToResume, parseMasterResume, parseResumeParseInput, parseTarget } from '@landed/schema/master-resume'
import { createLocalStore } from './store/local'

const raw = {
  basic: { name: 'Alex Rivera', email: 'alex@example.com', evil: '<script>' },
  entries: [
    { kind: 'internship', org: 'Brightwave', title: 'PM Intern', start_date: '2025-06', end_date: '2025-09', from: ['r1', 'r2'], bullets: [
      { variants: [{ text: 'Led discovery; 14 interviews', from: ['r1'] }, { text: 'Drove discovery (14 interviews)', from: ['r2'] }, { text: 'Led discovery; 14 interviews', from: ['r2'] }], preferred: 1 },
      { variants: [] },
      'Wrote the PRD',
    ] },
    { kind: 'job', org: 'Campus Cafe', title: 'Shift Lead', bullets: [{ variants: [{ text: 'Managed 6', from: [] }] }] },
    { title: '', org: '' },
  ],
  education: [{ school: 'State University', degree: 'BS' }],
  skills: ['SQL', 'sql', 'Python'],
}

describe('master resume', () => {
  test('parse: bounded, deduped, ids assigned, unknown kinds become experience', () => {
    const m = parseMasterResume(raw)!
    expect(m.basic.name).toBe('Alex Rivera')
    expect(m.basic).not.toHaveProperty('evil')
    expect(m.entries.map((e) => [e.id, e.kind, e.bullets.length])).toEqual([['e1', 'internship', 2], ['e2', 'experience', 1]])
    expect(m.entries[0].bullets[0]).toMatchObject({ id: 'e1b1', preferred: 1, variants: [{ text: 'Led discovery; 14 interviews' }, { text: 'Drove discovery (14 interviews)' }] })
    expect(m.skills).toEqual(['SQL', 'Python'])
    expect(masterStats(m)).toEqual({ entries: 2, bullets: 3, alternatives: 1 })
    expect(parseMasterResume({ entries: [] })).toBeNull()
  })

  test('flattened, it is an ordinary resume with the preferred phrasings', () => {
    const flat = safeNormalize(masterToResume(parseMasterResume(raw)!))
    expect(flat.ok).toBe(true)
    if (!flat.ok) return
    expect(flat.resume.internship[0]).toMatchObject({ company: 'Brightwave', description: '• Drove discovery (14 interviews)\n• Wrote the PRD' })
    expect(flat.resume.experience[0].company).toBe('Campus Cafe')
  })

  test('uploads: PDFs/images as base64 up to 8 MB, everything else as text', () => {
    expect(parseResumeParseInput({ name: 'CV', file: { type: 'application/pdf', data_base64: 'JVBERi0x' } })).toMatchObject({ file: { type: 'application/pdf' }, text: null })
    expect(parseResumeParseInput({ file: { type: 'application/x-msdownload', data_base64: 'TVqQ' } })).toBeNull()
    expect(parseResumeParseInput({ file: { type: 'application/pdf', data_base64: 'not base64!' } })).toBeNull()
    expect(parseResumeParseInput({ file: { type: 'application/pdf', data_base64: 'A'.repeat(12_000_000) } })).toBeNull()
    expect(parseResumeParseInput({ name: '', text: '  Alex Rivera, PM  ' })).toEqual({ name: 'Resume', file: null, text: 'Alex Rivera, PM' })
    expect(parseResumeParseInput({ text: '   ' })).toBeNull()
  })

  test('targets need a role; links must be http(s)', () => {
    expect(parseTarget({ role: '' })).toBeNull()
    expect(parseTarget({ role: 'APM', job_url: 'javascript:alert(1)' })).toMatchObject({ role: 'APM', job_url: null })
  })
})

describe('local store: resume kinds', () => {
  let n = 0
  const fresh = () => createLocalStore(`landed-resume-${++n}`)

  test('one master per account; versions carry their target and notes; uploads default to source', async () => {
    const store = fresh()
    const upload = await store.addResume({ name: 'PM resume', parsed_json: null, set_current: true })
    expect(upload).toMatchObject({ kind: 'source', master_json: null, target_json: null })
    const master = parseMasterResume(raw)!
    const m = await store.addResume({ name: 'Master resume', kind: 'master', master_json: master, parsed_json: null, set_current: false })
    expect(m.master_json?.entries).toHaveLength(2)
    await expect(store.addResume({ name: 'Another', kind: 'master', master_json: master, parsed_json: null, set_current: false })).rejects.toThrow(/already/)
    await expect(store.addResume({ name: 'Bad', kind: 'master', parsed_json: null, set_current: false })).rejects.toThrow(/master_json/)

    const v = await store.addResume({
      name: 'APM · Figma', kind: 'version', parsed_json: null, set_current: false,
      target_json: { role: 'APM', company: 'Figma', job_url: null, jd_text: null, application_id: null, notes: { summary: 'Leads with discovery', picks: [{ what: 'A/B bullet', why: 'experimentation' }] } },
    })
    expect(v.target_json).toMatchObject({ role: 'APM', notes: { picks: [{ what: 'A/B bullet' }] } })
    const edited = await store.updateResume(m.id, { master_json: { ...master, skills: ['Figma'] } })
    expect(edited.master_json?.skills).toEqual(['Figma'])
    await expect(store.updateResume(m.id, { master_json: { nonsense: true } as never })).rejects.toThrow(/master/)

    const snap = await store.exportSnapshot()
    const copy = fresh()
    await copy.replaceWith(snap)
    expect((await copy.listResumes()).map((r) => r.kind).sort()).toEqual(['master', 'source', 'version'])
  })
})
