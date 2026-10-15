// The account's application answers (packages/schema/src/application-answers.ts)
// and the files the extension uploads (application-files.ts), over the active
// data store. The extension gets a copy through the page bridge
// (hooks/extension-bridge.ts).
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import type { ApplicationAnswers } from '@landed/schema/application-answers'
import type { FileKind } from '@landed/schema/application-files'
import { useStore } from '../lib/store'

export function useApplicationAnswers() {
  const { store, ready } = useStore()
  return useQuery({
    queryKey: ['application_answers', store.kind],
    enabled: ready,
    queryFn: () => store.getApplicationAnswers(),
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

// ── files the extension uploads (resume, cover letter) ─────────────────────

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
