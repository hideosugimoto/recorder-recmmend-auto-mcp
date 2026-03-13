import { getDb, type KnowledgeRow } from '@claude-memory/shared'

/** Minimum confidence score for candidates */
const CONFIDENCE_THRESHOLD = 0.5

/** Confidence thresholds for display tiers */
const CONFIDENCE_NORMAL = 0.7
const CONFIDENCE_WARNING = 0.5

export interface Candidate {
  knowledgeId: number
  title: string
  category: string
  hitCount: number
  patternOccurrences: number
  priority: number
  confidenceScore: number
  confidenceTier: 'normal' | 'warning'
  suggestedAction: string
  content: string
  tags: string
}

/**
 * Detect candidates for Skills/MCP generation using a single LEFT JOIN query.
 * N+1 queries are prohibited by design.
 *
 * Filter: hit_count >= threshold AND promoted=FALSE AND confidence_score >= CONFIDENCE_THRESHOLD
 * Priority: hitCount × patternOccurrences (descending)
 */
export function detectCandidates(threshold = 3, project?: string, limit = 5): Candidate[] {
  const db = getDb()

  const rows = db.prepare(`
    SELECT
      k.id as knowledge_id,
      k.title,
      k.category,
      k.hit_count,
      k.confidence_score,
      k.content,
      k.tags,
      COALESCE(SUM(p.occurrences), 1) as pattern_occurrences
    FROM knowledge k
    LEFT JOIN patterns p ON p.category =
      CASE k.category
        WHEN 'mcp' THEN 'mcp_candidate'
        ELSE 'skills_candidate'
      END
    WHERE k.hit_count >= ?
      AND k.promoted = FALSE
      AND k.confidence_score >= ?
      AND (k.project = ? OR k.project IS NULL)
    GROUP BY k.id
    ORDER BY (k.hit_count * COALESCE(SUM(p.occurrences), 1)) DESC
    LIMIT ?
  `).all(threshold, CONFIDENCE_THRESHOLD, project, limit) as Array<{
    knowledge_id: number
    title: string
    category: string
    hit_count: number
    confidence_score: number
    content: string
    tags: string
    pattern_occurrences: number
  }>

  return rows.map(row => ({
    knowledgeId: row.knowledge_id,
    title: row.title,
    category: row.category,
    hitCount: row.hit_count,
    patternOccurrences: row.pattern_occurrences,
    priority: row.hit_count * row.pattern_occurrences,
    confidenceScore: row.confidence_score,
    confidenceTier: row.confidence_score >= CONFIDENCE_NORMAL ? 'normal' as const : 'warning' as const,
    suggestedAction: getSuggestedAction(row.category),
    content: row.content,
    tags: row.tags,
  }))
}

/**
 * Derive suggested action from category.
 */
function getSuggestedAction(category: string): string {
  switch (category) {
    case 'mcp': return 'generate_mcp'
    case 'rule': return 'propose_claude_md'
    default: return 'generate_skill'
  }
}

/**
 * Format candidates for display in tool response.
 */
export function formatProposals(candidates: Candidate[]): string {
  if (candidates.length === 0) return ''

  const lines = ['📋 Skills/MCP候補が見つかりました:\n']

  for (const c of candidates) {
    const warning = c.confidenceTier === 'warning' ? ' ⚠️ 要確認' : ''
    lines.push(`  ${c.knowledgeId}. 「${c.title}」 (${c.hitCount}回検出, ${c.category})${warning}`)
    lines.push(`     → ${c.suggestedAction} で生成可能`)
  }

  lines.push('\n生成するには architect の generate_skill / generate_mcp ツールを使ってください。')
  return lines.join('\n')
}
