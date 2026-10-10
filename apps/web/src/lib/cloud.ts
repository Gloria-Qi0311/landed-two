// Turning Landed Cloud sync on and off for the signed-in account, plus
// backup files. Every flow is ordered so a failure part-way never loses data:
//
//   sync on:   upload this device's data + flip cloud_sync in one server
//              transaction → then clear the device copy
//              (upload fails → nothing changed, device data untouched)
//   sync off:  download Cloud data → write it to this device → server
//              deletes its copy + flips cloud_sync (password-checked)
//              (wrong password → the fresh device copy is discarded again)
import { api } from './api'
import { useAuth, type User } from './auth'
import { cloudStore, localStoreFor } from './store'
import { BACKUP_FORMAT, BACKUP_VERSION, SNAPSHOT_TABLES, snapshotRowCount, type Snapshot } from './store/types'

function signedInUser(): User {
  const user = useAuth.getState().user
  if (!user) throw new Error('not signed in')
  return user
}

export async function turnOnCloudSync() {
  const user = signedInUser()
  const device = localStoreFor(user.id)
  const snapshot = await device.exportSnapshot()
  await api.post('/cloud/enable', snapshot)
  // The data is in Cloud now; drop the device copy so there's one source of truth.
  await device.clearAll().catch(() => {})
  useAuth.getState().setUser({ ...user, cloud_sync: true })
  return { uploaded: snapshotRowCount(snapshot) }
}

export async function turnOffCloudSync(password: string) {
  const user = signedInUser()
  const device = localStoreFor(user.id)
  const snapshot = await cloudStore.exportSnapshot()
  await device.replaceWith(snapshot)
  try {
    await api.post('/cloud/disable', { password })
  } catch (e) {
    // Still syncing (e.g. wrong password): the copy we just wrote would be stale.
    await device.clearAll().catch(() => {})
    throw e
  }
  useAuth.getState().setUser({ ...user, cloud_sync: false })
}

export async function signOut() {
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

/** Restore a backup: merges into Cloud, or replaces this device's data. */
export async function restoreBackup(snapshot: Snapshot) {
  const user = signedInUser()
  if (user.cloud_sync) await api.post('/sync/upload', snapshot)
  else await localStoreFor(user.id).replaceWith(snapshot)
}

export function summarize(snapshot: Snapshot) {
  return {
    applications: snapshot.applications?.length ?? 0,
    resumes: snapshot.resumes?.length ?? 0,
    total: snapshotRowCount(snapshot),
  }
}
