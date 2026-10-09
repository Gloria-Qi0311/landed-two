// Page side of the Landed web ↔ extension bridge (extension counterpart:
// apps/extension/lib/web-bridge.js + lib/bridge-handler.js).
//
// The extension's content script is injected only on Landed's own origins
// and relays window.postMessage requests to its service worker. If the
// extension isn't installed, requests simply time out and resolve to null —
// every caller treats "no extension" as a normal state.

const TO_EXTENSION = 'landed-web'
const FROM_EXTENSION = 'landed-extension'
const TIMEOUT_MS = 2000

type Reply = { source: string; id?: string; type?: string; ok?: boolean; data?: unknown; error?: string }

export function bridgeRequest<T>(type: string, payload?: unknown): Promise<T | null> {
  return new Promise((resolve) => {
    const id = crypto.randomUUID()
    const done = (value: T | null) => {
      window.removeEventListener('message', onMessage)
      clearTimeout(timer)
      resolve(value)
    }
    const onMessage = (e: MessageEvent<Reply>) => {
      if (e.source !== window || e.data?.source !== FROM_EXTENSION || e.data.id !== id) return
      done(e.data.ok ? (e.data.data as T) : null)
    }
    const timer = setTimeout(() => done(null), TIMEOUT_MS)
    window.addEventListener('message', onMessage)
    window.postMessage({ source: TO_EXTENSION, id, type, payload }, window.location.origin)
  })
}

/** Fires when the extension's content script announces itself (page load,
 *  or the extension being installed/reloaded while the tab is open). */
export function onExtensionReady(cb: () => void): () => void {
  const onMessage = (e: MessageEvent<Reply>) => {
    if (e.source === window && e.data?.source === FROM_EXTENSION && e.data.type === 'ready') cb()
  }
  window.addEventListener('message', onMessage)
  return () => window.removeEventListener('message', onMessage)
}
