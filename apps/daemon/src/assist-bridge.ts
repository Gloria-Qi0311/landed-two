// Local file bridge between the macOS menu-bar app and browser extensions.
//
// Chrome Native Messaging is browser-initiated: a desktop app cannot ask an
// extension to do something on its own. The extension therefore keeps one
// native port open. Its host publishes a small, non-sensitive snapshot here
// (tab titles/URLs and resume names, never resume contents), then watches a
// mode-0700 command queue for requests written by Landed.app.
import { randomUUID } from 'node:crypto'
import { chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { home } from './config.ts'

export type AssistTab = { id: number; title: string; url: string; active: boolean }
export type AssistResume = { id: string; name: string; is_current: boolean; created_at: string }
export type AssistResult = {
  command_id: string
  completed_at: string
  filled: number
  review: number
  failed: number
  summary: string
}
export type AssistSnapshot = {
  session_id: string
  browser: string
  tabs: AssistTab[]
  resumes: AssistResume[]
}
export type AssistSession = AssistSnapshot & {
  connected_at: string
  last_seen: string
  ollama_ready: boolean
  ollama_model: string | null
  last_result: AssistResult | null
}
export type AssistFillCommand = {
  type: 'assist_fill'
  command_id: string
  session_id: string
  tab_ids: number[]
  resume_id: string
}

const validId = (value: unknown, max = 100) => typeof value === 'string'
  && value.length >= 1 && value.length <= max && /^[A-Za-z0-9_.:-]+$/.test(value)

export const assistRoot = () => join(home(), 'apply-assist')
export const assistSessionsDir = () => join(assistRoot(), 'sessions')
export const assistCommandsDir = () => join(assistRoot(), 'commands')

function ensureDirs() {
  for (const dir of [assistRoot(), assistSessionsDir(), assistCommandsDir()]) {
    mkdirSync(dir, { recursive: true, mode: 0o700 })
    chmodSync(dir, 0o700)
  }
}

export function sanitizeSnapshot(raw: unknown): AssistSnapshot | null {
  if (!raw || typeof raw !== 'object') return null
  const value = raw as Record<string, unknown>
  if (!validId(value.session_id, 80)) return null
  const browser = typeof value.browser === 'string' ? value.browser.trim().slice(0, 80) : 'Browser'
  const tabs: AssistTab[] = Array.isArray(value.tabs) ? value.tabs.slice(0, 100).flatMap((item) => {
    if (!item || typeof item !== 'object') return []
    const tab = item as Record<string, unknown>
    const id = Number(tab.id)
    const title = typeof tab.title === 'string' ? tab.title.trim().slice(0, 300) : ''
    const url = typeof tab.url === 'string' ? tab.url.trim().slice(0, 3000) : ''
    if (!Number.isSafeInteger(id) || id < 0 || !/^https?:\/\//i.test(url)) return []
    return [{ id, title: title || new URL(url).hostname, url, active: tab.active === true }]
  }) : []
  const resumes: AssistResume[] = Array.isArray(value.resumes) ? value.resumes.slice(0, 50).flatMap((item) => {
    if (!item || typeof item !== 'object') return []
    const resume = item as Record<string, unknown>
    if (!validId(resume.id, 120) || typeof resume.name !== 'string') return []
    return [{
      id: resume.id as string,
      name: resume.name.trim().slice(0, 200) || 'Resume',
      is_current: resume.is_current === true,
      created_at: typeof resume.created_at === 'string' ? resume.created_at.slice(0, 50) : '',
    }]
  }) : []
  return { session_id: value.session_id as string, browser: browser || 'Browser', tabs, resumes }
}

export function writeAssistSession(session: AssistSession) {
  ensureDirs()
  const target = join(assistSessionsDir(), `${session.session_id}.json`)
  const temp = `${target}.${process.pid}.${randomUUID()}.tmp`
  writeFileSync(temp, `${JSON.stringify(session, null, 2)}\n`, { mode: 0o600 })
  renameSync(temp, target)
  chmodSync(target, 0o600)
}

export function mergeAssistSession(previous: AssistSession | null, snapshot: AssistSnapshot, now: string): AssistSession {
  return {
    ...snapshot,
    connected_at: previous?.connected_at ?? now,
    last_seen: now,
    ollama_ready: previous?.ollama_ready ?? false,
    ollama_model: previous?.ollama_model ?? null,
    last_result: previous?.last_result ?? null,
  }
}

export function sanitizeAssistResult(raw: unknown): AssistResult | null {
  if (!raw || typeof raw !== 'object') return null
  const value = raw as Record<string, unknown>
  if (!validId(value.command_id, 100)) return null
  const count = (item: unknown) => Number.isSafeInteger(Number(item))
    ? Math.max(0, Math.min(10_000, Number(item))) : 0
  return {
    command_id: value.command_id as string,
    completed_at: new Date().toISOString(),
    filled: count(value.filled),
    review: count(value.review),
    failed: count(value.failed),
    summary: typeof value.summary === 'string' ? value.summary.slice(0, 500) : '',
  }
}

export function removeAssistSession(sessionId: string) {
  if (validId(sessionId, 80)) rmSync(join(assistSessionsDir(), `${sessionId}.json`), { force: true })
}

function sanitizeCommand(raw: unknown): AssistFillCommand | null {
  if (!raw || typeof raw !== 'object') return null
  const value = raw as Record<string, unknown>
  if (value.type !== 'assist_fill' || !validId(value.command_id, 100) || !validId(value.session_id, 80) || !validId(value.resume_id, 120)) return null
  const tabIds = Array.isArray(value.tab_ids)
    ? [...new Set(value.tab_ids.map(Number).filter((id) => Number.isSafeInteger(id) && id >= 0))].slice(0, 5)
    : []
  if (tabIds.length === 0) return null
  return {
    type: 'assist_fill',
    command_id: value.command_id as string,
    session_id: value.session_id as string,
    tab_ids: tabIds,
    resume_id: value.resume_id as string,
  }
}

/** Atomically claim commands for one connected extension session. */
export function takeAssistCommands(sessionId: string): AssistFillCommand[] {
  if (!validId(sessionId, 80) || !existsSync(assistCommandsDir())) return []
  const commands: AssistFillCommand[] = []
  const now = Date.now()
  for (const name of readdirSync(assistCommandsDir()).filter((name) => name.endsWith('.json')).slice(0, 200)) {
    const path = join(assistCommandsDir(), name)
    let raw: unknown
    try {
      // Remove abandoned/invalid queue entries after one day.
      if (now - statSync(path).mtimeMs > 24 * 60 * 60_000) {
        rmSync(path, { force: true })
        continue
      }
      raw = JSON.parse(readFileSync(path, 'utf8'))
    } catch {
      rmSync(path, { force: true })
      continue
    }
    const command = sanitizeCommand(raw)
    if (!command) {
      rmSync(path, { force: true })
      continue
    }
    if (command.session_id !== sessionId) continue
    rmSync(path, { force: true })
    commands.push(command)
  }
  return commands
}
