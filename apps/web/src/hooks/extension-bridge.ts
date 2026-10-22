// Keeps the extension and the active data store in step while a Landed tab
// is open:
//   - pulls the extension's queued portal events (on load, when the
//     extension announces itself, on focus, and every minute) and writes
//     them to the active store — in local mode this is how portal sync
//     reaches the user's data at all
//   - turns the submissions the extension saw ("thanks for applying"
//     pages) into applications — lib/inbox/confirmations.ts → ingestPortalConfirmations
//   - takes the questions fills had to leave empty and keeps them with the
//     application answers, for the Extension page to ask the user once
//     (packages/schema/src/application-answers.ts → addUnanswered)
//   - makes each tailored version's one-page PDF (lib/resume-pdf.ts) and
//     hands the extension the ones it doesn't have, so a fill with that
//     version uploads it
//   - hands the user's resumes to the extension so the side panel can
//     autofill without a Cloud account, the application answers (Extension
//     page) so fills can answer choice questions, and the files it uploads
//     (only the ones the extension doesn't have yet)
import { useEffect } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { create } from 'zustand'
import { bridgeCall, bridgeRequest, onExtensionReady } from '../lib/extension-bridge'
import { useStore, type PortalEventInput } from '../lib/store'
import { ingestPortalConfirmations } from '../lib/inbox'
import { useResumes } from './resumes'
import { useApplicationAnswers, useApplicationFiles, useResumeFiles } from './answers'
import { adoptKeptFiles } from '../lib/resume-tasks'
import { FILE_KINDS } from '@landed/schema/application-files'
import { addUnanswered, EMPTY_ANSWERS, type ReportedQuestion } from '@landed/schema/application-answers'
import {
  APPLY_ASSIST_RESULT_EVENT,
  nextStepForAssistResult,
  parseApplyAssistResults,
} from '../lib/apply-batch'

const PULL_INTERVAL_MS = 60_000
/** The hash an upload with no file of its own is handed over with. */
const NO_FILE = '0000000000000000'


/** Files the extension couldn't keep (its storage full, or a write it
 *  refused), by resume id or `file:<kind>`: shown where the file is, since an
 *  application then can't upload it. Cleared when a later hand-over works. */
export const useFileHandoff = create<{ errors: Record<string, string> }>(() => ({ errors: {} }))

/** Hand one file over; remember whether it worked. A missing extension isn't
 *  a failure (nothing to tell). */
async function handOver(key: string, type: 'sync-file' | 'sync-version-pdf', payload: unknown) {
  const res = await bridgeCall(type, payload, 15_000)
  const errors = { ...useFileHandoff.getState().errors }
  if (res.ok || res.error === 'no_extension') delete errors[key]
  else errors[key] = res.error
  useFileHandoff.setState({ errors })
}

export function useExtensionBridge() {
  const qc = useQueryClient()
  const { store, ready } = useStore()
  const { data: resumes } = useResumes()
  const { data: answers } = useApplicationAnswers()
  const { data: files } = useApplicationFiles()
  const { data: resumeFiles } = useResumeFiles()

  useEffect(() => {
    if (!ready) return
    let pulling = false
    const pull = async () => {
      if (pulling) return
      pulling = true
      try {
        const res = await bridgeRequest<{ rows: PortalEventInput[] }>('take-events')
        if (res?.rows?.length) {
          await store.addPortalEvents(res.rows)
          qc.invalidateQueries({ queryKey: ['portal_events'] })
        }
        const asked = await bridgeRequest<{ questions: ReportedQuestion[] }>('take-questions')
        if (asked?.questions?.length) {
          const current = (await store.getApplicationAnswers())?.answers ?? EMPTY_ANSWERS
          const next = addUnanswered(current, asked.questions, new Date().toISOString())
          if (JSON.stringify(next.unanswered) !== JSON.stringify(current.unanswered)) {
            await store.saveApplicationAnswers(next)
            qc.invalidateQueries({ queryKey: ['application_answers'] })
          }
        }
        // A Landed-opened application page finished filling, or stopped at
        // a human-only login/account/CAPTCHA. Keep that on the application
        // card and notify the batch control; one result never gates another.
        const assist = await bridgeRequest<{ results: unknown[] }>('take-assist-results')
        const results = parseApplyAssistResults(assist?.results)
        if (results.length) {
          const apps = await store.listApplications()
          let changed = false
          for (const result of results) {
            const app = result.application_id ? apps.find((a) => a.id === result.application_id) : null
            if (app?.stage === 'saved') {
              const next_step = nextStepForAssistResult(result)
              if (app.next_step !== next_step) {
                const updated = await store.updateApplication(app.id, { next_step })
                Object.assign(app, updated)
                changed = true
              }
            }
            window.dispatchEvent(new CustomEvent(APPLY_ASSIST_RESULT_EVENT, { detail: result }))
          }
          if (changed) qc.invalidateQueries({ queryKey: ['applications'] })
        }
      } catch (e) {
        console.warn('[landed] could not store events from the extension', e)
      } finally {
        pulling = false
      }
    }
    void pull()
    const timer = setInterval(pull, PULL_INTERVAL_MS)
    window.addEventListener('focus', pull)
    const offReady = onExtensionReady(pull)
    return () => {
      clearInterval(timer)
      window.removeEventListener('focus', pull)
      offReady()
    }
  }, [store, ready, qc])

  // Runs when events arrive (local: the pull above stores them; Cloud: the
  // extension pushes them and the server streams them back), on load and on
  // focus — one tab at a time, so two tabs don't add the same one twice.
  useEffect(() => {
    if (!ready) return
    let running = false
    let again = false
    const work = () => ingestPortalConfirmations(store)
    const run = async () => {
      if (running) {
        again = true
        return
      }
      running = true
      try {
        do {
          again = false
          const n = navigator.locks ? await navigator.locks.request('landed:portal-confirmations', work) : await work()
          if (n) for (const key of ['applications', 'suggestions', 'job_leads', 'companies']) qc.invalidateQueries({ queryKey: [key] })
        } while (again)
      } catch (e) {
        console.warn('[landed] could not apply submissions the extension saw', e)
      } finally {
        running = false
      }
    }
    void run()
    window.addEventListener('focus', run)
    const off = store.subscribePortalEvents((row) => {
      if (row.type === 'status-change' && row.payload_json?.to === 'applied' && row.payload_json?.source !== 'agent') void run()
    })
    return () => {
      window.removeEventListener('focus', run)
      off()
    }
  }, [store, ready, qc])

  useEffect(() => {
    if (answers === undefined) return
    const send = () => void bridgeRequest('sync-answers', { answers: answers?.answers ?? null })
    send()
    return onExtensionReady(send)
  }, [answers])

  useEffect(() => {
    if (!files) return
    let cancelled = false
    const sync = async () => {
      const have = await bridgeRequest<Record<string, string | null>>('file-ids')
      if (!have || cancelled) return // no extension here
      for (const kind of FILE_KINDS) {
        const meta = files.find((f) => f.kind === kind) ?? null
        if ((have[kind] ?? null) === (meta?.id ?? null)) continue
        const content = meta ? await store.getApplicationFileData(kind) : null
        if (cancelled) return
        await handOver(`file:${kind}`, 'sync-file', {
          kind, file: meta && content ? { id: meta.id, name: meta.name, mime: meta.mime, data: content.data } : null,
        })
      }
    }
    void sync().catch((e) => console.warn('[landed] could not hand files to the extension', e))
    const off = onExtensionReady(() => void sync().catch(() => {}))
    return () => {
      cancelled = true
      off()
    }
  }, [files, store])

  useEffect(() => {
    if (!resumes) return
    const send = () => void bridgeRequest('sync-resumes', {
      resumes: resumes.map(({ id, name, parsed_json, is_current, created_at, kind, target_json }) => ({
        id, name, parsed_json, is_current, created_at, kind,
        // A tailored version's job, so the extension picks it for that page.
        target: target_json ? { role: target_json.role, company: target_json.company, job_url: target_json.job_url, application_id: target_json.application_id } : null,
      })),
    })
    send()
    return onExtensionReady(send)
  }, [resumes])

  // Uploads from before resumes kept their own files: the account's resume
  // file goes to the upload named after it (lib/resume-tasks.ts), once.
  useEffect(() => {
    if (!ready || !resumes || !resumeFiles || !files) return
    void adoptKeptFiles(store).then((n) => { if (n) void qc.invalidateQueries({ queryKey: ['resume_files'] }) })
      .catch((e) => console.warn('[landed] could not give the kept file to its resume', e))
  }, [ready, store, qc, resumes, resumeFiles, files])

  // Each resume's own file, by resume id, for the fill to upload the picked
  // one's and never another's: an upload's original (null when it has none,
  // so the extension knows), a tailored version's one-page PDF (made here, in
  // the browser; never stored). Only the ones the extension lacks or that
  // changed.
  useEffect(() => {
    if (!resumes || !resumeFiles) return
    let cancelled = false
    const versions = resumes
      .filter((r) => r.kind === 'version' && r.parsed_json)
      .sort((a, b) => b.created_at.localeCompare(a.created_at))
      .slice(0, 20)
    const uploads = resumes.filter((r) => r.kind === 'source').slice(0, 20)
    const fileOf = new Map(resumeFiles.map((f) => [f.resume_id, f]))
    const sync = async () => {
      const have = await bridgeRequest<Record<string, string>>('version-pdf-ids')
      if (!have || cancelled) return // no extension here
      for (const u of uploads) {
        const meta = fileOf.get(u.id)
        const hash = meta ? meta.id.replace(/-/g, '') : NO_FILE
        if (have[u.id] === hash) continue
        const content = meta ? await store.getResumeFileData(u.id) : null
        if (cancelled) return
        await handOver(u.id, 'sync-version-pdf', {
          resume_id: u.id, hash,
          file: meta && content ? { id: meta.id, name: meta.name, mime: meta.mime, data: content.data } : null,
        })
      }
      const { makeResumePdf, toBase64, versionHash } = await import('../lib/resume-pdf')
      const { normalizeResume } = await import('@landed/schema')
      for (const v of versions) {
        const hash = await versionHash(v.parsed_json)
        if (have[v.id] === hash) continue
        let pdf: Awaited<ReturnType<typeof makeResumePdf>> | null = null
        try {
          pdf = await makeResumePdf(normalizeResume(v.parsed_json))
        } catch (e) {
          console.warn('[landed] could not make the PDF for', v.name, e)
        }
        if (cancelled) return
        await handOver(v.id, 'sync-version-pdf', {
          resume_id: v.id, hash,
          file: pdf?.ok ? { id: v.id, name: pdf.name, mime: 'application/pdf', data: toBase64(pdf.bytes) } : null,
        })
      }
      const keep = new Set([...versions, ...uploads].map((r) => r.id))
      for (const id of Object.keys(have)) {
        if (!keep.has(id) && !cancelled) await bridgeRequest('sync-version-pdf', { resume_id: id, remove: true })
      }
    }
    void sync().catch((e) => console.warn('[landed] could not hand resume files to the extension', e))
    const off = onExtensionReady(() => void sync().catch(() => {}))
    return () => {
      cancelled = true
      off()
    }
  }, [resumes, resumeFiles, store])
}
