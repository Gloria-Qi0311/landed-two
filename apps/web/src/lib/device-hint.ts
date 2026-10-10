// When to explain an empty browser to a sync-off account. Its data lives in
// whichever browser it was added in, so signing in somewhere new shows an
// empty Landed — which looks like data loss unless we say why.
//
// Shown only for established accounts (finished onboarding, older than an
// hour) so brand-new users with nothing yet aren't told about "other devices".

export const EMPTY_DEVICE_HINT_AGE_MS = 60 * 60 * 1000

export function shouldShowEmptyDeviceHint(input: {
  cloudSync: boolean
  onboardedAt: string | null | undefined
  accountCreatedAt: string | null | undefined
  deviceEmpty: boolean | undefined
  dismissed: boolean
  now?: number
}): boolean {
  const { cloudSync, onboardedAt, accountCreatedAt, deviceEmpty, dismissed, now = Date.now() } = input
  if (cloudSync || dismissed || deviceEmpty !== true || !onboardedAt || !accountCreatedAt) return false
  return now - Date.parse(accountCreatedAt) >= EMPTY_DEVICE_HINT_AGE_MS
}

const key = (userId: string) => `landed:hint-empty-device:${userId}`

export function isEmptyDeviceHintDismissed(userId: string): boolean {
  try {
    return localStorage.getItem(key(userId)) === '1'
  } catch {
    return false
  }
}

export function dismissEmptyDeviceHint(userId: string) {
  try {
    localStorage.setItem(key(userId), '1')
  } catch {
    // storage blocked — the hint just shows again next time
  }
}
