// Moving between "this device" (local mode, the default) and Landed Cloud,
// plus backup files. Every flow is ordered so a failure part-way never
// loses data:
//
//   turn on Cloud:  sign in → upload device snapshot → clear device → switch
//                   (upload fails → sign back out, device data untouched)
//   leave Cloud:    download snapshot → delete account (password) → write device
//                   (device write fails → snapshot saved as a backup file)
//   sign out:       Cloud keeps the data; the device goes back to local mode
import { api } from './api'
import { useAuth, type User } from './auth'
import { cloudStore, localStore } from './store'
import { BACKUP_FORMAT, BACKUP_VERSION, SNAPSHOT_TABLES, snapshotRowCount, type Snapshot } from './store/types'

export async function turnOnCloud(input: { email: string; password: string; isSignup: boolean }) {
  const { user } = await api.post<{ user: User }>(input.isSignup ? '/auth/signup' : '/auth/login', {
    email: input.email,
    password: input.password,
  })
  let uploaded = 0
  try {
    const snapshot = await localStore.exportSnapshot()
    uploaded = snapshotRowCount(snapshot)
    if (uploaded > 0) {
      await api.post('/sync/upload', snapshot)
      await localStore.clearAll()
    }
  } catch (e) {
    // Stay in local mode with the device data intact.
    await api.post('/auth/logout').catch(() => {})
    throw new Error(`Couldn't move this device's data to Landed Cloud: ${(e as Error).message}`)
  }
  useAuth.getState().setUser(user)
  return { uploaded }
}

export async function leaveCloud(password: string) {
  const snapshot = await cloudStore.exportSnapshot()
  // Throws on a wrong password before anything changes.
  await api.del('/me', { password })
  try {
    await localStore.replaceWith(snapshot)
  } catch (e) {
    downloadBackup(snapshot)
    useAuth.getState().setUser(null)
    throw new Error(
      `Your cloud account is deleted, but saving to this browser failed (${(e as Error).message}). ` +
        'A backup file was downloaded instead — use Import backup to restore it.',
    )
  }
  useAuth.getState().setUser(null)
}

export async function signOutOfCloud() {
  await useAuth.getState().signOut()
}

// ── backup files ──────────────────────────────────────────────────────────

export function downloadBackup(snapshot: Snapshot) {
  const blob = new Blob([JSON.stringify(snapshot, null, 2)], { type: 'application/json' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = `landed-backup-${snapshot.exported_at.slice(0, 10)}.json`
  document.body.appendChild(a)
  a.click()
  a.remove()
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}

export async function readBackupFile(file: File): Promise<Snapshot> {
  let data: unknown
  try {
    data = JSON.parse(await file.text())
  } catch {
    throw new Error('That file is not valid JSON.')
  }
  const s = data as Partial<Snapshot> | null
  if (!s || s.format !== BACKUP_FORMAT) throw new Error('That file is not a Landed backup.')
  if (s.version !== BACKUP_VERSION) throw new Error(`Unsupported backup version ${String(s.version)}.`)
  for (const t of SNAPSHOT_TABLES) {
    if (s[t] !== undefined && !Array.isArray(s[t])) throw new Error(`Backup is damaged (${t}).`)
  }
  return { profile: { onboarded_at: null }, ...s } as Snapshot
}

/** Restore a backup: replaces this device's data, or merges into Cloud. */
export async function restoreBackup(snapshot: Snapshot) {
  if (useAuth.getState().user) await api.post('/sync/upload', snapshot)
  else await localStore.replaceWith(snapshot)
}

export function summarize(snapshot: Snapshot) {
  return {
    applications: snapshot.applications?.length ?? 0,
    resumes: snapshot.resumes?.length ?? 0,
    total: snapshotRowCount(snapshot),
  }
}
