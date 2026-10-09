// Keeps the extension and the active data store in step while a Landed tab
// is open:
//   - pulls the extension's queued portal events (on load, when the
//     extension announces itself, on focus, and every minute) and writes
//     them to the active store — in local mode this is how portal sync
//     reaches the user's data at all
//   - hands the user's resumes to the extension so the side panel can
//     autofill without a Cloud account
import { useEffect } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { bridgeRequest, onExtensionReady } from '../lib/extension-bridge'
import { useStore, type PortalEventInput } from '../lib/store'
import { useResumes } from './resumes'

const PULL_INTERVAL_MS = 60_000

export function useExtensionBridge() {
  const qc = useQueryClient()
  const { store, ready } = useStore()
  const { data: resumes } = useResumes()

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

  useEffect(() => {
    if (!resumes) return
    const send = () => void bridgeRequest('sync-resumes', {
      resumes: resumes.map(({ id, name, parsed_json, is_current, created_at }) => ({ id, name, parsed_json, is_current, created_at })),
    })
    send()
    return onExtensionReady(send)
  }, [resumes])
}
