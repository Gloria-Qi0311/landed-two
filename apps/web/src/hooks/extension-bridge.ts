// Keeps the extension and the active data store in step while a Landed tab
// is open:
//   - pulls the extension's queued portal events (on load, when the
//     extension announces itself, on focus, and every minute) and writes
//     them to the active store — in local mode this is how portal sync
//     reaches the user's data at all
//   - turns the submissions the extension saw ("thanks for applying"
//     pages) into applications — lib/inbox.ts → ingestPortalConfirmations
//   - hands the user's resumes to the extension so the side panel can
//     autofill without a Cloud account, and the application answers
//     (Extension page) so fills can answer choice questions
import { useEffect } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { bridgeRequest, onExtensionReady } from '../lib/extension-bridge'
import { useStore, type PortalEventInput } from '../lib/store'
import { ingestPortalConfirmations } from '../lib/inbox'
import { useResumes } from './resumes'
import { useApplicationAnswers } from './answers'

const PULL_INTERVAL_MS = 60_000

export function useExtensionBridge() {
  const qc = useQueryClient()
  const { store, ready } = useStore()
  const { data: resumes } = useResumes()
  const { data: answers } = useApplicationAnswers()

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
    if (!resumes) return
    const send = () => void bridgeRequest('sync-resumes', {
      resumes: resumes.map(({ id, name, parsed_json, is_current, created_at }) => ({ id, name, parsed_json, is_current, created_at })),
    })
    send()
    return onExtensionReady(send)
  }, [resumes])
}
