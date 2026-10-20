// A resume uploaded without a computer: saved with what the browser reads,
// the file kept, and read in full once a computer is connected.
import 'fake-indexeddb/auto'
import { beforeEach, describe, expect, test, vi } from 'vitest'
import { createLocalStore } from './store/local'

// The app runs in a browser; Node 24 has neither sessionStorage nor FileReader.
if (typeof globalThis.sessionStorage === 'undefined') {
  const data = new Map<string, string>()
  globalThis.sessionStorage = {
    getItem: (key: string) => data.get(key) ?? null, setItem: (key: string, value: string) => void data.set(key, String(value)),
    removeItem: (key: string) => void data.delete(key), clear: () => data.clear(), key: (i: number) => [...data.keys()][i] ?? null,
    get length() { return data.size },
  } as Storage
}
if (typeof globalThis.FileReader === 'undefined') {
  globalThis.FileReader = class {
    result: string | null = null
    onload: (() => void) | null = null
    onerror: (() => void) | null = null
    readAsDataURL(blob: Blob) {
      void blob.arrayBuffer().then((b) => { this.result = `data:${blob.type};base64,${btoa(String.fromCharCode(...new Uint8Array(b)))}`; this.onload?.() })
    }
  } as unknown as typeof FileReader
}

const RESUME_TEXT = 'Alex Rivera\nalex.rivera@example.com | (555) 010-0199 | linkedin.com/in/alex-rivera-example'
const jobs: { kind: string; input: Record<string, unknown> }[] = []
const listeners = new Map<string, (e: { type: string; output?: unknown; message?: string }) => void>()
vi.mock('../hooks/runtimes', () => ({
  startJob: async (_rt: string, _agent: string, kind: string, input: Record<string, unknown>) => {
    jobs.push({ kind, input })
    return `job-${jobs.length}`
  },
  followJob: (id: string, on: (e: { type: string }) => void) => { listeners.set(id, on); return () => listeners.delete(id) },
}))
vi.mock('./resume-basics', async (actual) => ({
  ...(await actual<typeof import('./resume-basics')>()),
  // pdf.js's browser build doesn't run in Node; reading a PDF is tested in resume-basics.test.ts.
  resumeText: async () => RESUME_TEXT,
}))
const { useResumeTask } = await import('./resume-tasks')

let n = 0
const fresh = () => createLocalStore(`landed-waiting-${++n}`)
const target = { runtime: { id: 'rt', name: 'Example Mac' }, agent: { id: 'claude', label: 'Claude Code' } } as never
const pdf = (name = 'Alex Rivera Resume.pdf') => new File([new Uint8Array([37, 80, 68, 70, 45, 49])], name, { type: 'application/pdf' })
async function until(check: () => Promise<boolean> | boolean, ms = 3000) {
  const end = Date.now() + ms
  while (!(await check())) {
    if (Date.now() > end) throw new Error('timed out')
    await new Promise((r) => setTimeout(r, 10))
  }
}

beforeEach(() => {
  jobs.length = 0
  listeners.clear()
  useResumeTask.setState({ userId: null, task: null, uploads: [] })
})

describe('uploading without a computer', () => {
  test('saved with the basics, the file kept, waiting; read in full once a computer is connected', async () => {
    const store = fresh()
    useResumeTask.getState().bind(`u${n}`, { store, onData: () => {} })
    await useResumeTask.getState().uploadWaiting(pdf())

    let [row] = await store.listResumes()
    expect(row).toMatchObject({ kind: 'source', is_current: true, file_path: 'Alex Rivera Resume.pdf', name: 'Alex Rivera Resume' })
    expect(row.parsed_json?.basic).toMatchObject({ name: 'Alex Rivera', email: 'alex.rivera@example.com', phone: '(555) 010-0199' })
    expect(row.parsed_json?.education).toEqual([])
    expect((await store.listApplicationFiles()).map((f) => [f.kind, f.name])).toEqual([['resume', 'Alex Rivera Resume.pdf']])
    expect(useResumeTask.getState().uploads.map((u) => u.status)).toEqual(['waiting'])
    expect(jobs).toEqual([])

    // A computer is connected: the kept file is read, once.
    await useResumeTask.getState().readWaiting(target, row)
    await useResumeTask.getState().readWaiting(target, row)
    expect(jobs.map((j) => j.kind)).toEqual(['resume_parse'])
    expect(jobs[0].input).toMatchObject({ name: 'Alex Rivera Resume', file: { type: 'application/pdf', data_base64: btoa('%PDF-1') } })

    listeners.get('job-1')!({ type: 'done', output: {
      basic: { name: 'Alex Rivera', email: 'alex.rivera@example.com' },
      education: [{ school: 'Example State University', degree: 'B.S.', major: 'Computer Science', end_date: '2027-06' }],
      skills: ['TypeScript'],
    } })
    await until(async () => !(await store.listResumes())[0].file_path)
    ;[row] = await store.listResumes()
    expect(row).toMatchObject({ file_path: null, is_current: true })
    expect(row.parsed_json?.education[0].school).toBe('Example State University')
    expect((await store.listResumes()).filter((r) => r.kind === 'source')).toHaveLength(1)
    // …and the master is built from it.
    await until(() => jobs.length === 2)
    expect(jobs[1].kind).toBe('resume_merge')
  })

  test('a photo, or a file over 3 MB, needs the computer: nothing saved', async () => {
    const store = fresh()
    useResumeTask.getState().bind(`u${n}`, { store, onData: () => {} })
    await useResumeTask.getState().uploadWaiting(new File([new Uint8Array(10)], 'resume.png', { type: 'image/png' }))
    expect(useResumeTask.getState().uploads.at(-1)).toMatchObject({ status: 'error', error: expect.stringMatching(/PDF or Word/) })
    await useResumeTask.getState().uploadWaiting(new File([new Uint8Array(3 * 1024 * 1024 + 1)], 'big.pdf', { type: 'application/pdf' }))
    expect(useResumeTask.getState().uploads.at(-1)).toMatchObject({ status: 'error', error: expect.stringMatching(/3 MB/) })
    expect(await store.listResumes()).toEqual([])
    expect(await store.listApplicationFiles()).toEqual([])
  })

  test('if its file was replaced on the Extension page, it says so instead of reading the wrong one', async () => {
    const store = fresh()
    useResumeTask.getState().bind(`u${n}`, { store, onData: () => {} })
    await useResumeTask.getState().uploadWaiting(pdf())
    await store.saveApplicationFile({ kind: 'resume', name: 'Someone Else.pdf', data: btoa('%PDF-2') })
    const [row] = await store.listResumes()
    await useResumeTask.getState().readWaiting(target, row)
    expect(jobs).toEqual([])
    expect(useResumeTask.getState().uploads.at(-1)).toMatchObject({ status: 'error', replace_id: row.id })
    expect((await store.listResumes())[0].file_path).toBe('Alex Rivera Resume.pdf')
  })
})

test('file_path is a file name or null', async () => {
  const store = fresh()
  const row = await store.addResume({ name: 'A', parsed_json: null, set_current: false, file_path: 'a.pdf' })
  expect(row.file_path).toBe('a.pdf')
  expect((await store.updateResume(row.id, { file_path: null })).file_path).toBeNull()
  await expect(store.updateResume(row.id, { file_path: 'x'.repeat(256) })).rejects.toThrow(/file_path/)
  await expect(store.addResume({ name: 'B', parsed_json: null, set_current: false, file_path: 42 as never })).rejects.toThrow(/file_path/)
})
