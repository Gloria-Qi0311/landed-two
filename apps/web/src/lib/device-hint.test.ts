import { describe, expect, test } from 'vitest'
import { shouldShowEmptyDeviceHint } from './device-hint'

const NOW = Date.parse('2026-10-10T00:00:00Z')
const base = {
  cloudSync: false, onboardedAt: '2026-10-09T15:00:00Z', accountCreatedAt: '2026-10-09T14:46:00Z',
  deviceEmpty: true, dismissed: false, now: NOW,
}

describe('shouldShowEmptyDeviceHint', () => {
  test('established sync-off account on an empty browser', () => {
    expect(shouldShowEmptyDeviceHint(base)).toBe(true)
  })
  test.each([
    ['Cloud sync on (data follows the account)', { cloudSync: true }],
    ['this browser already has data', { deviceEmpty: false }],
    ['emptiness not known yet', { deviceEmpty: undefined }],
    ['brand-new account still onboarding', { onboardedAt: null }],
    ['account younger than an hour', { accountCreatedAt: '2026-10-09T23:30:00Z' }],
    ['dismissed on this browser', { dismissed: true }],
  ])('hidden when %s', (_label, over) => {
    expect(shouldShowEmptyDeviceHint({ ...base, ...over })).toBe(false)
  })
})
