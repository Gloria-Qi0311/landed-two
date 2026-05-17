// packages/extension-core/src/portal-parsers — barrel.
//
// One module per supported ATS. Each exports:
//   - is{Portal}Url(url): boolean
//   - parse{Portal}Page(root, url, now?): null | PortalEvent
//   - parseSubmitConfirmation(root, url, now?)
//   - parseAppliedBadge(root, url)  (when the portal exposes one)
//
// Currently Greenhouse only (#33). Lever / Workday / Ashby land in
// follow-up PRs (#33.1 / #33.2 / #33.3) — same shape.
//
// Output event shape (consumed by #34's service-worker diff + #35's
// push-to-Landed flow):
//   { kind: 'applied' | 'already_applied' | 'status-change' | 'rejection',
//     company: string,
//     role: string,
//     applied_at?: string,    // ISO timestamp, present on 'applied' / 'status-change'
//     app_url: string,
//     detected_via?: string,  // diagnostic
//   }
export * as greenhouse from './greenhouse.js'
