// The account's application answers (packages/schema/src/application-answers.ts)
// and the files the extension uploads (application-files.ts), over the active
// data store. The extension gets a copy through the page bridge
// (hooks/extension-bridge.ts).
import { useEffect, useRef } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { EMPTY_ANSWERS, parseApplicationAnswers, type ApplicationAnswers } from '@landed/schema/application-answers'
import type { FileKind } from '@landed/schema/application-files'
import { suggestAnswers, withSuggestions } from '../lib/answer-suggestions'
import { screeningResume } from '../lib/screen'
import { useStore } from '../lib/store'
import { useResumes } from './resumes'
import { useJobSearches } from './search'

export function useApplicationAnswers() {
  const { store, ready } = useStore()
  return useQuery({
    queryKey: ['application_answers', store.kind],
    enabled: ready,
    // Saved before a field existed, a row lacks it: read as the full shape.
    queryFn: async () => {
      const row = await store.getApplicationAnswers()
      return row && { ...row, answers: parseApplicationAnswers(row.answers) }
    },
  })
}

export function useSaveApplicationAnswers() {
  const qc = useQueryClient()
  const { store } = useStore()
  return useMutation({
    mutationFn: (answers: ApplicationAnswers) => store.saveApplicationAnswers(answers),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['application_answers'] }),
  })
}

/** Mount once below the login gate: what the resume and the active search
 *  already say goes into the blank application answers on its own (each
 *  question once), so the extension has it and the user doesn't type it
 *  again (lib/answer-suggestions.ts; the Extension page marks them). */
export function useKnownAnswers() {
  const stored = useApplicationAnswers()
  const resumes = useResumes().data
  const searches = useJobSearches().data
  const { mutate } = useSaveApplicationAnswers()
  // The saved answers last filled in from: once per version of them, so a
  // save isn't repeated before the saved answers come back.
  const filledFrom = useRef<{ data: unknown; known: string } | null>(null)
  useEffect(() => {
    if (stored.data === undefined || !resumes || !searches) return
    const answers = stored.data?.answers ?? EMPTY_ANSWERS
    const brief = searches.find((s) => s.status === 'active')?.brief ?? null
    const known = suggestAnswers({ resume: screeningResume(resumes), brief, answers })
    const sig = JSON.stringify(known)
    if (known.length === 0 || (filledFrom.current?.data === stored.data && filledFrom.current.known === sig)) return
    filledFrom.current = { data: stored.data, known: sig }
    mutate(withSuggestions(answers, known), { onError: (e) => console.warn('[landed] filling in known answers failed', e) })
  }, [stored.data, resumes, searches, mutate])
}

// ── files the extension uploads (resume, cover letter) ─────────────────────

/** Each uploaded resume's own file (metadata): what a fill with it uploads. */
export function useResumeFiles() {
  const { store, ready } = useStore()
  return useQuery({
    queryKey: ['resume_files', store.kind],
    enabled: ready,
    queryFn: () => store.listResumeFiles(),
  })
}

export function useApplicationFiles() {
  const { store, ready } = useStore()
  return useQuery({
    queryKey: ['application_files', store.kind],
    enabled: ready,
    queryFn: () => store.listApplicationFiles(),
  })
}

export function useSaveApplicationFile() {
  const qc = useQueryClient()
  const { store } = useStore()
  return useMutation({
    mutationFn: (input: { kind: FileKind; name: string; data: string }) => store.saveApplicationFile(input),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['application_files'] }),
  })
}

export function useDeleteApplicationFile() {
  const qc = useQueryClient()
  const { store } = useStore()
  return useMutation({
    mutationFn: (kind: FileKind) => store.deleteApplicationFile(kind),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['application_files'] }),
  })
}
