// Safari Web Extensions cannot launch Chrome-style Native Messaging hosts.
// Their native app extension forwards messages to this loopback-only server
// instead. The protocol mirrors native-host.ts while returning queued menu
// commands in the response, so no browser data leaves this Mac.
import { createServer, type Server } from 'node:http'
import {
  mergeAssistSession, sanitizeAssistResult, sanitizeSnapshot, takeAssistCommands, writeAssistSession,
  type AssistSession,
} from './assist-bridge.ts'
import { handleNativeMessage } from './native-host.ts'

export const SAFARI_BRIDGE_HOST = '127.0.0.1'
export const SAFARI_BRIDGE_PORT = 17_841
const MAX_BODY_BYTES = 1024 * 1024

type NativeHandler = (message: unknown) => Promise<Record<string, unknown>>

export function createSafariBridgeHandler(nativeHandler: NativeHandler = handleNativeMessage) {
  const sessions = new Map<string, AssistSession>()

  return async (message: unknown): Promise<Record<string, unknown>> => {
    if (!message || typeof message !== 'object') return { ok: false, error: 'invalid message' }
    const typed = message as Record<string, unknown>

    if (typed.type === 'bridge_hello' || typed.type === 'bridge_state') {
      const snapshot = sanitizeSnapshot(typed)
      if (!snapshot || snapshot.browser !== 'Safari') return { ok: false, error: 'invalid Safari bridge state' }
      const now = new Date().toISOString()
      const session = mergeAssistSession(sessions.get(snapshot.session_id) ?? null, snapshot, now)
      sessions.set(snapshot.session_id, session)
      writeAssistSession(session)

      if (typed.type === 'bridge_hello') {
        void nativeHandler({ type: 'ping' }).then((status) => {
          const current = sessions.get(snapshot.session_id)
          if (!current) return
          current.ollama_ready = status.ok === true
          current.ollama_model = typeof status.model === 'string' ? status.model : null
          current.last_seen = new Date().toISOString()
          writeAssistSession(current)
        })
      }

      return {
        ok: true,
        messages: [
          { type: 'bridge_ready', session_id: snapshot.session_id },
          ...takeAssistCommands(snapshot.session_id),
        ],
      }
    }

    if (typed.type === 'bridge_result') {
      const sessionId = typeof typed.session_id === 'string' ? typed.session_id : ''
      const session = sessions.get(sessionId)
      const result = sanitizeAssistResult(typed)
      if (!session || !result) return { ok: false, error: 'unknown Safari bridge session' }
      session.last_result = result
      session.last_seen = result.completed_at
      writeAssistSession(session)
      return { ok: true, messages: [{ type: 'bridge_result_saved', command_id: result.command_id }] }
    }

    return nativeHandler(message)
  }
}

export function startSafariBridgeServer(
  log: (message: string) => void = () => {},
  port = SAFARI_BRIDGE_PORT,
): Promise<Server> {
  const handle = createSafariBridgeHandler()
  const server = createServer((request, response) => {
    if (request.method !== 'POST' || request.url !== '/safari-bridge') {
      response.writeHead(404).end()
      return
    }
    let size = 0
    let tooLarge = false
    const chunks: Buffer[] = []
    request.on('data', (chunk: Buffer) => {
      if (tooLarge) return
      size += chunk.length
      if (size > MAX_BODY_BYTES) {
        tooLarge = true
        chunks.length = 0
      } else chunks.push(chunk)
    })
    request.on('end', () => {
      if (tooLarge) {
        response.writeHead(413, { 'content-type': 'application/json' }).end(JSON.stringify({ ok: false, error: 'message is too large' }))
        return
      }
      let body: unknown
      try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')) }
      catch {
        response.writeHead(400, { 'content-type': 'application/json' }).end(JSON.stringify({ ok: false, error: 'invalid JSON' }))
        return
      }
      void handle(body).then((result) => {
        response.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' }).end(JSON.stringify(result))
      }, (error) => {
        response.writeHead(500, { 'content-type': 'application/json' }).end(JSON.stringify({ ok: false, error: String(error) }))
      })
    })
  })
  return new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(port, SAFARI_BRIDGE_HOST, () => {
      server.off('error', reject)
      server.on('error', (error) => log(`Safari bridge error: ${error.message}`))
      log(`Safari bridge listening on http://${SAFARI_BRIDGE_HOST}:${port}`)
      resolve(server)
    })
  })
}
