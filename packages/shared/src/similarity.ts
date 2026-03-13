import { distance } from 'fastest-levenshtein'

/** Levenshtein distance threshold for considering titles "similar" */
const SIMILARITY_THRESHOLD = 0.3

/**
 * Find the most similar title from candidates using Levenshtein distance.
 * Returns null if no candidate is within the similarity threshold.
 *
 * Threshold: normalized distance <= 0.3 (i.e., at most 30% of characters differ).
 */
export function findByLevenshtein(
  title: string,
  candidates: ReadonlyArray<{ id: number; title: string }>
): { id: number; title: string } | null {
  if (candidates.length === 0) {
    return null
  }

  const normalizedTitle = title.toLowerCase().trim()
  let bestMatch: { id: number; title: string } | null = null
  let bestScore = Infinity

  for (const candidate of candidates) {
    const normalizedCandidate = candidate.title.toLowerCase().trim()
    const dist = distance(normalizedTitle, normalizedCandidate)
    const maxLen = Math.max(normalizedTitle.length, normalizedCandidate.length)

    if (maxLen === 0) continue

    const normalizedDist = dist / maxLen

    if (normalizedDist <= SIMILARITY_THRESHOLD && dist < bestScore) {
      bestScore = dist
      bestMatch = candidate
    }
  }

  return bestMatch
}
