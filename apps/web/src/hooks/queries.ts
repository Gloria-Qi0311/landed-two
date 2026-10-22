// TanStack Query hooks over the active data store (this device, or Landed
// Cloud when signed in — see lib/store). Components stay UI-only and read
// `useApplications()` / `useCompanies()` etc. instead of receiving the data
// via props.
//
// Why a transform layer (toAppShape / toCompanyShape):
// The DB uses snake_case + real timestamps (last_activity_at, applied_at).
// The original prototype components were written against the seed data shape
// (camelCase + days-ago integers like appliedDays). Rather than touch every
// component, the hook returns the row reshaped into the legacy prototype
// shape. Eventually we'll refactor consumers to read DB-shape directly; for
// now this keeps the diff small.
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { useStore, type ApplicationPatch, type DbApplication, type DbCompany } from '../lib/store'
import { COMPANIES as COMPANY_CATALOG, APPLICATIONS as SEED_APPS, COMPANIES as SEED_COMPANIES } from '../data'

// ─── shapes ────────────────────────────────────────────────────────────────

const daysSince = (iso: string | null) =>
  iso ? Math.floor((Date.now() - new Date(iso).getTime()) / 86400000) : 0

function toAppShape(row: DbApplication) {
  return {
    id: row.id,
    companyId: row.company_id,
    role: row.role,
    team: row.team ?? '',
    stage: row.stage,
    salary: row.salary ?? '—',
    location: row.location ?? '',
    remote: row.remote ?? 'Hybrid',
    appliedDays: daysSince(row.applied_at),
    lastActivity: daysSince(row.last_activity_at),
    nextStep: row.next_step ?? '',
    referral: row.referral,
    source: row.source ?? '',
    jobId: row.job_id ?? '',
    portal_application_url: row.portal_application_url,
    notes: row.notes ?? '',
    starred: row.starred,
    interviews: row.interviews ?? [],
    deadline: row.deadline ?? null,
  }
}

/** An application as the board, cards and drawer show it. */
export type BoardApp = ReturnType<typeof toAppShape>

function toCompanyShape(row: DbCompany) {
  return {
    id: row.id,
    name: row.name,
    // No color or initials of its own: the mark derives them from the name.
    hue: row.hue ?? null,
    logo: row.logo_chars ?? null,
    sector: row.sector ?? '',
    loc: row.loc ?? '',
    portalOk: true, // legacy field — derived from portal_connections in #20
  }
}

/** A company as the board shows it. */
export type BoardCompany = ReturnType<typeof toCompanyShape>

// ─── reads ─────────────────────────────────────────────────────────────────

export function useApplications() {
  const { store, ready } = useStore()
  return useQuery({
    queryKey: ['applications', store.kind],
    enabled: ready,
    queryFn: async () => (await store.listApplications()).map(toAppShape),
  })
}

export function useCompanies() {
  const { store, ready } = useStore()
  return useQuery({
    queryKey: ['companies', store.kind],
    enabled: ready,
    queryFn: async () => (await store.listCompanies()).map(toCompanyShape),
  })
}

// ─── writes ────────────────────────────────────────────────────────────────

export function useUpdateApplication() {
  const qc = useQueryClient()
  const { store } = useStore()
  const key = ['applications', store.kind]
  return useMutation({
    mutationFn: async ({ id, patch }: { id: string; patch: ApplicationPatch }) =>
      // The store whitelists ApplicationPatch fields and bumps last_activity_at.
      toAppShape(await store.updateApplication(id, patch)),
    onMutate: async ({ id, patch }) => {
      await qc.cancelQueries({ queryKey: key })
      const previous = qc.getQueryData<any[]>(key)
      // The card shape names next_step `nextStep`.
      const shaped = patch.next_step !== undefined ? { ...patch, nextStep: patch.next_step ?? '' } : patch
      qc.setQueryData<any[]>(key, (old) =>
        (old ?? []).map((a) => (a.id === id ? { ...a, ...shaped } : a)),
      )
      return { previous }
    },
    onError: (_err, _vars, ctx) => {
      if (ctx?.previous) qc.setQueryData(key, ctx.previous)
    },
    onSettled: () => qc.invalidateQueries({ queryKey: ['applications'] }),
  })
}

/** Delete an application (and what hangs off it — see DataStore.deleteApplication). */
export function useDeleteApplication() {
  const qc = useQueryClient()
  const { store } = useStore()
  return useMutation({
    mutationFn: (id: string) => store.deleteApplication(id),
    onSuccess: () => {
      for (const key of ['applications', 'suggestions', 'job_leads', 'portal_events']) qc.invalidateQueries({ queryKey: [key] })
    },
  })
}

// Add an application. If the company doesn't exist for this user, create it
// first (looks up by name; matches the catalog entry by name if it's a
// known company so we inherit hue + logo).
export function useAddApplication() {
  const qc = useQueryClient()
  const { store } = useStore()
  return useMutation({
    mutationFn: async (input: {
      companyName: string
      role: string
      team?: string
      stage?: string
      salary?: string
      location?: string
      source?: string
      notes?: string
    }) => {
      // The store finds-or-creates the company by name in the same
      // transaction. Catalog entry (if it's a known company) supplies the
      // hue + logo + sector + loc for a newly-created company.
      const cat = COMPANY_CATALOG.find((c: any) => c.name === input.companyName)
      const stage = input.stage ?? 'applied'
      const data = await store.addApplication(
        {
          name: input.companyName,
          hue: cat?.hue ?? null,
          logo_chars: cat?.logo ?? input.companyName.slice(0, 2).toUpperCase(),
          sector: cat?.sector ?? null,
          loc: cat?.loc ?? input.location ?? null,
        },
        {
          role: input.role,
          team: input.team || null,
          stage,
          salary: input.salary || null,
          location: input.location || null,
          remote: 'Hybrid',
          applied_at: stage === 'saved' ? null : new Date().toISOString(),
          next_step: stage === 'saved' ? 'Tailor resume' : 'Awaiting response',
          source: input.source || 'Manual',
          notes: input.notes || null,
        },
      )
      return toAppShape(data)
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['applications'] })
      qc.invalidateQueries({ queryKey: ['companies'] })
    },
  })
}

// Bulk-import the seed APPLICATIONS into the current user's tables.
// Called from the empty state when a brand-new user clicks "Try with demo data".
export function useImportDemoData() {
  const qc = useQueryClient()
  const { store } = useStore()
  return useMutation({
    mutationFn: async () => {
      // 1. Companies referenced by the seed apps (only the ones we use)
      const usedCompanyIds = new Set(SEED_APPS.map((a: any) => a.companyId))
      const companies = SEED_COMPANIES
        .filter((c: any) => usedCompanyIds.has(c.id))
        .map((c: any) => ({
          name: c.name,
          hue: c.hue,
          logo_chars: c.logo,
          sector: c.sector,
          loc: c.loc,
        }))

      // 2. Applications reference their company by name (seed IDs aren't
      // UUIDs); the store maps names to the new company rows.
      const seedCompanyById = new Map<string, any>()
      SEED_COMPANIES.forEach((c: any) => seedCompanyById.set(c.id, c))

      const applications = SEED_APPS.map((a: any) => {
        const seedCo = seedCompanyById.get(a.companyId)
        if (!seedCo) return null
        const appliedAt = a.appliedDays > 0
          ? new Date(Date.now() - a.appliedDays * 86400000).toISOString()
          : null
        const lastActivityAt = new Date(Date.now() - (a.lastActivity ?? 0) * 86400000).toISOString()
        return {
          company_name: seedCo.name,
          role: a.role,
          team: a.team || null,
          stage: a.stage,
          salary: a.salary || null,
          location: a.location || null,
          remote: a.remote || 'Hybrid',
          applied_at: appliedAt,
          last_activity_at: lastActivityAt,
          next_step: a.nextStep || null,
          referral: !!a.referral,
          source: a.source || null,
          job_id: a.jobId || null,
          notes: a.notes || null,
          starred: !!a.starred,
          interviews: a.interviews ?? [],
        }
      }).filter((a): a is NonNullable<typeof a> => a !== null)

      return store.importApplications({ companies, applications })
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['applications'] })
      qc.invalidateQueries({ queryKey: ['companies'] })
    },
  })
}
