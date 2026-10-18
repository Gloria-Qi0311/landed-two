// One-off repairs of stored data.
import { orderRounds, sortRounds } from '@landed/schema/pipeline'
import type { DataStore } from '../store/types'

export async function repairRoundOrder(store: DataStore): Promise<number> {
  let fixed = 0
  for (const a of await store.listApplications()) {
    const ordered = sortRounds(orderRounds(a.interviews ?? []))
    if (JSON.stringify(ordered) === JSON.stringify(a.interviews ?? [])) continue
    await store.updateApplication(a.id, { interviews: ordered })
    fixed++
  }
  return fixed
}
