// The account's application answers (packages/schema/src/application-answers.ts),
// over the active data store. The extension gets a copy through the page
// bridge (hooks/extension-bridge.ts) to answer choice questions on forms.
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import type { ApplicationAnswers } from '@landed/schema/application-answers'
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
