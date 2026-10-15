// "Thanks for applying" pages the extension saw → applications, once each.
import 'fake-indexeddb/auto'
import { describe, expect, test } from 'vitest'
import { canUndo, ingestPortalConfirmations, isSeenConfirmation, recordApplyClick, undoSuggestion } from './inbox'
import { createLocalStore } from './store/local'

let n = 0
const fresh = () => createLocalStore(`landed-confirm-${++n}`)

// What the extension's bridge hands the page (lib/portal-events-push.js → mapEventToRow).
const submitted = (company: string, role: string, extra: Record<string, unknown> = {}) => ({
  type: 'status-change' as const,
  payload_json: {
    source: 'greenhouse', company, role, app_url: 'https://job-boards.greenhouse.io/acme/jobs/123/confirmation',
    detected_via: 'confirmation-page', raw_kind: 'applied', from: null, to: 'applied', applied_at: '2026-10-14T09:30:00.000Z', ...extra,
  },
})

describe('submissions the extension saw', () => {
  test('a new one is added as Applied, once — deleting it doesn\'t bring it back', async () => {
    const store = fresh()
    await store.addPortalEvents([submitted('Acme', 'Product Manager')])
    expect(await ingestPortalConfirmations(store)).toBe(1)
    const [app] = await store.listApplications()
    expect(app).toMatchObject({ role: 'Product Manager', stage: 'applied', source: 'Portal (extension)', applied_at: '2026-10-14T12:00:00.000Z' })
    const [ledger] = await store.listSuggestions()
    expect(ledger).toMatchObject({ kind: 'new_application', state: 'auto_applied', application_id: app.id, provider: 'extension' })

    await store.addPortalEvents([submitted('Acme', 'Product Manager')]) // the page reloaded
    expect(await ingestPortalConfirmations(store)).toBe(0)
    await store.deleteApplication(app.id)
    expect(await ingestPortalConfirmations(store)).toBe(0)
    expect(await store.listApplications()).toHaveLength(0)
  })

  test('a saved one moves to Applied (undoable); one already further along stays put, quietly', async () => {
    const store = fresh()
    const saved = await store.addApplication({ name: 'Acme Inc.' }, { role: 'Product Manager', stage: 'saved' })
    const oa = await store.addApplication({ name: '字节跳动' }, { role: '产品经理', stage: 'oa' })
    await store.addPortalEvents([submitted('Acme', 'Product Manager'), submitted('字节跳动', '产品经理', { app_url: 'https://jobs.bytedance.com/x' })])
    expect(await ingestPortalConfirmations(store)).toBe(1)
    const apps = await store.listApplications()
    expect(apps.find((a) => a.id === saved.id)?.stage).toBe('applied')
    expect(apps.find((a) => a.id === oa.id)?.stage).toBe('oa')

    const ledger = await store.listSuggestions()
    const moved = ledger.find((s) => s.application_id === saved.id)!
    expect(moved).toMatchObject({ kind: 'stage_change', state: 'auto_applied', previous_stage: 'saved' })
    expect(canUndo(moved)).toBe(true)
    expect(isSeenConfirmation(ledger.find((s) => s.application_id === oa.id)!)).toBe(true)
    await undoSuggestion(store, moved, apps)
    expect((await store.listApplications()).find((a) => a.id === saved.id)?.stage).toBe('saved')
  })

  test('opened from Landed: the exact application or lead, whatever the page calls it', async () => {
    const store = fresh()
    const app = await store.addApplication({ name: 'Acme' }, { role: 'PM, Growth', stage: 'saved' })
    const lead = await store.saveJobLead({
      id: crypto.randomUUID(), fingerprint: 'job:y', ats_key: null, canonical_url: null, company_key: 'globex', title_key: 'designer', company_name: 'Globex', title: 'Designer',
      job_url: null, location: null, description: null, deadline: null, sources: [], status: 'new', application_id: null, first_seen_at: new Date().toISOString(), last_seen_at: new Date().toISOString(),
    } as never)
    await store.addPortalEvents([
      submitted('Acme Corp', 'Senior Product Manager — Growth', { application_id: app.id }),
      submitted('Globex Corporation', 'Product Designer II', { lead_id: lead.id, app_url: 'https://jobs.lever.co/globex/abc/thanks' }),
    ])
    expect(await ingestPortalConfirmations(store)).toBe(2)
    const apps = await store.listApplications()
    expect(apps).toHaveLength(2)
    expect(apps.find((a) => a.id === app.id)).toMatchObject({ stage: 'applied', portal_application_url: 'https://job-boards.greenhouse.io/acme/jobs/123/confirmation' })
    expect((await store.listJobLeads())[0].application_id).toBe(apps.find((a) => a.id !== app.id)?.id)
  })

  test('answers "did you apply?" and ignores what isn\'t a submission', async () => {
    const store = fresh()
    const app = await store.addApplication({ name: 'Acme' }, { role: 'Product Manager', stage: 'saved' })
    await recordApplyClick(store, { kind: 'application', id: app.id, role: app.role, stage: 'saved', company_name: 'Acme' })
    await store.addPortalEvents([
      { type: 'status-change', payload_json: { source: 'agent', how: 'auto', from: 'saved', to: 'applied' } }, // Landed's own log
      submitted('', 'Product Manager'), // no company
      { type: 'rejection', payload_json: { source: 'greenhouse', company: 'Acme', role: 'Product Manager', raw_kind: 'rejection' } },
    ])
    expect(await ingestPortalConfirmations(store)).toBe(0)
    await store.addPortalEvents([submitted('Acme', 'Product Manager')])
    expect(await ingestPortalConfirmations(store)).toBe(1)
    const question = (await store.listSuggestions()).find((s) => s.dedupe_key.startsWith('click:'))
    expect(question?.state).not.toBe('pending')
  })

  test('old events (over 30 days) are left alone', async () => {
    const store = fresh()
    await store.addPortalEvents([submitted('Acme', 'Product Manager')])
    expect(await ingestPortalConfirmations(store, Date.now() + 31 * 86_400_000)).toBe(0)
  })
})
