import { getDb, type KnowledgeRow } from '@claude-memory/shared'
import { findByLevenshtein } from '@claude-memory/shared'

/**
 * Upsert a single knowledge item following the design's upsert policy:
 * - Similar title + promoted=FALSE: hit_count+1, update content/tags
 * - Similar title + promoted=TRUE: hit_count+1 only (protect user edits)
 * - No similar title: new INSERT
 */
export function upsertKnowledge(
  sessionId: string,
  project: string,
  item: {
    category: string
    title: string
    content: string
    tags: string[]
  }
): { action: 'insert' | 'update'; id: number } {
  const db = getDb()

  const existing = db.prepare(`
    SELECT id, title, promoted, confidence_score FROM knowledge
    WHERE project = ? AND category = ?
    ORDER BY hit_count DESC
  `).all(project, item.category) as Array<{ id: number; title: string; promoted: number; confidence_score: number }>

  const match = findByLevenshtein(item.title, existing.map(e => ({ id: e.id, title: e.title })))

  if (match) {
    const matchedRow = existing.find(e => e.id === match.id)
    if (matchedRow && matchedRow.promoted) {
      db.prepare(`
        UPDATE knowledge
        SET hit_count = hit_count + 1,
            updated_at = datetime('now')
        WHERE id = ?
      `).run(match.id)
    } else {
      db.prepare(`
        UPDATE knowledge
        SET hit_count = hit_count + 1,
            content = ?,
            tags = ?,
            session_id = ?,
            updated_at = datetime('now')
        WHERE id = ?
      `).run(item.content, JSON.stringify(item.tags), sessionId, match.id)
    }
    return { action: 'update', id: match.id }
  }

  const result = db.prepare(`
    INSERT INTO knowledge (session_id, project, category, title, content, tags)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(sessionId, project, item.category, item.title, item.content, JSON.stringify(item.tags))

  return { action: 'insert', id: Number(result.lastInsertRowid) }
}

/**
 * Search knowledge by query string (title and content).
 * Increments reference_count on each result.
 */
export function searchKnowledge(
  query: string,
  project?: string
): KnowledgeRow[] {
  const db = getDb()
  const likeQuery = `%${query}%`

  const rows = db.prepare(`
    SELECT * FROM knowledge
    WHERE (title LIKE ? OR content LIKE ? OR tags LIKE ?)
      ${project ? 'AND (project = ? OR project IS NULL)' : ''}
      AND confidence_score >= 0.5
    ORDER BY hit_count DESC, reference_count DESC
    LIMIT 20
  `).all(
    likeQuery, likeQuery, likeQuery,
    ...(project ? [project] : [])
  ) as KnowledgeRow[]

  // Increment reference_count for returned results
  const updateStmt = db.prepare(`
    UPDATE knowledge
    SET reference_count = reference_count + 1,
        last_referenced_at = datetime('now')
    WHERE id = ?
  `)
  for (const row of rows) {
    updateStmt.run(row.id)
  }

  return rows
}

/**
 * Review knowledge items with low confidence.
 */
export function reviewKnowledge(id?: number): KnowledgeRow[] {
  const db = getDb()

  if (id !== undefined) {
    return db.prepare('SELECT * FROM knowledge WHERE id = ?').all(id) as KnowledgeRow[]
  }

  return db.prepare(`
    SELECT * FROM knowledge
    WHERE confidence_score <= 0.7
    ORDER BY confidence_score ASC
    LIMIT 20
  `).all() as KnowledgeRow[]
}

/**
 * List recent sessions.
 */
export function listSessions(limit = 10) {
  const db = getDb()
  return db.prepare(`
    SELECT id, project, analysis_status, summary, recorded_at, analyzed_at, cost_usd
    FROM sessions
    ORDER BY created_at DESC
    LIMIT ?
  `).all(limit)
}

/**
 * Get cost summary for a period.
 */
export function showCost(period: 'today' | 'week' | 'month' = 'month', project?: string) {
  const db = getDb()
  const dateFilter = {
    today: "datetime('now', 'start of day')",
    week: "datetime('now', '-7 days')",
    month: "datetime('now', 'start of month')",
  }[period]

  return db.prepare(`
    SELECT
      COUNT(*) as session_count,
      COALESCE(SUM(input_tokens), 0) as total_input_tokens,
      COALESCE(SUM(output_tokens), 0) as total_output_tokens,
      COALESCE(SUM(cost_usd), 0) as total_cost_usd
    FROM sessions
    WHERE analyzed_at >= ${dateFilter}
      ${project ? 'AND project = ?' : ''}
  `).get(...(project ? [project] : [])) as {
    session_count: number
    total_input_tokens: number
    total_output_tokens: number
    total_cost_usd: number
  }
}
