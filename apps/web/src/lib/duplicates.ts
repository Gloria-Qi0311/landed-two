// Multi-portal duplicate detection (spec.md §8 #1).
//
// When a user has applied to the same role at the same company via two
// different portals (Greenhouse on the company's careers page AND the
// company's own ATS, say), both rows show up — by design, we don't auto-
// dedupe, but the UI surfaces a "Possible duplicate" badge so the user
// can decide whether to consolidate.
//
// Key = "{companyId}|{normalizedRole}". Role normalization is light
// (lowercase + collapse whitespace) so "Senior Frontend Engineer" matches
// "senior frontend engineer" but not "Senior FE Engineer". Tight, on
// purpose — better to under-flag than to falsely merge distinct roles.

type AppLike = { id: string; companyId: string; role: string }

const normalizeRole = (role: string): string =>
  role.trim().toLowerCase().replace(/\s+/g, ' ')

/**
 * Returns the set of application IDs that share their (companyId, role)
 * combination with at least one other application. Both/all members of a
 * duplicate group are included so the UI can badge each card.
 */
export function findDuplicateAppIds(apps: AppLike[]): Set<string> {
  const groups = new Map<string, string[]>()
  for (const a of apps) {
    if (!a.companyId || !a.role) continue
    const key = `${a.companyId}|${normalizeRole(a.role)}`
    const arr = groups.get(key)
    if (arr) arr.push(a.id)
    else groups.set(key, [a.id])
  }
  const dups = new Set<string>()
  for (const ids of groups.values()) {
    if (ids.length > 1) {
      for (const id of ids) dups.add(id)
    }
  }
  return dups
}
