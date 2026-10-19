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
//   - hands the user's resumes to the extension so the side panel can
//     autofill without a Cloud account, the application answers (Extension
//     page) so fills can answer choice questions, and the files it uploads
//     (only the ones the extension doesn't have yet)
import { useEffect } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { bridgeRequest, onExtensionReady } from '../lib/extension-bridge'
import { useStore, type PortalEventInput } from '../lib/store'
import { ingestPortalConfirmations } from '../lib/inbox'
import { useResumes } from './resumes'
import { useApplicationAnswers, useApplicationFiles } from './answers'
import { FILE_KINDS } from '@landed/schema/application-files'
import { addUnanswered, EMPTY_ANSWERS, type ReportedQuestion } from '@landed/schema/application-answers'

const PULL_INTERVAL_MS = 60_000

export function useExtensionBridge() {
  const qc = useQueryClient()
  const { store, ready } = useStore()
  const { data: resumes } = useResumes()
  const { data: answers } = useApplicationAnswers()
  const { data: files } = useApplicationFiles()

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
        await bridgeRequest('sync-file', {
          kind, file: meta && content ? { id: meta.id, name: meta.name, mime: meta.mime, data: content.data } : null,
        }, 15_000)
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
}
