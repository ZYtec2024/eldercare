import type { ManualSosCandidate } from '@/services/adapters/dispatch-adapter'

/** Dedupe by volunteer_id and split Top1 vs others. One person never appears twice. */
export function splitSosCandidates(list: ManualSosCandidate[] | null | undefined) {
  const seen = new Set<number>()
  const unique: ManualSosCandidate[] = []
  for (const item of list || []) {
    const id = Number(item.volunteer_id)
    if (!Number.isFinite(id) || seen.has(id)) continue
    seen.add(id)
    unique.push({ ...item, volunteer_id: id })
  }
  return {
    recommended: unique[0] ?? null,
    alternates: unique.slice(1),
  }
}

/** Keep only people who are not the recommended Top1. */
export function excludeRecommended(
  list: ManualSosCandidate[] | null | undefined,
  recommended: ManualSosCandidate | null | undefined,
) {
  const topId = Number(recommended?.volunteer_id)
  const seen = new Set<number>(Number.isFinite(topId) ? [topId] : [])
  const out: ManualSosCandidate[] = []
  for (const item of list || []) {
    const id = Number(item.volunteer_id)
    if (!Number.isFinite(id) || seen.has(id)) continue
    seen.add(id)
    out.push({ ...item, volunteer_id: id })
  }
  return out
}
