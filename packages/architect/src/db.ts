import {
  getDb,
  acquireAnalysisLock,
  markAnalysisFailed,
  markAnalysisSkipped,
  resetFailedToPending,
  getPendingSessions,
  type SessionRow,
  type KnowledgeRow,
} from '@claude-memory/shared'

export {
  acquireAnalysisLock,
  markAnalysisFailed,
  markAnalysisSkipped,
  resetFailedToPending,
  getPendingSessions,
}

/**
 * Get knowledge count for the current project.
 */
export function getKnowledgeCount(project: string): number {
  const db = getDb()
  const row = db.prepare(`
    SELECT COUNT(*) as count FROM knowledge
    WHERE project = ? OR project IS NULL
  `).get(project) as { count: number }
  return row.count
}

/**
 * Get failed session count for display.
 */
export function getFailedCount(project: string): number {
  const db = getDb()
  const row = db.prepare(`
    SELECT COUNT(*) as count FROM sessions
    WHERE analysis_status = 'failed'
      AND (project = ? OR project IS NULL)
  `).get(project) as { count: number }
  return row.count
}

/**
 * Check pending TTL: skip sessions that have been pending too long.
 */
export function skipExpiredPending(pendingTtlDays = 7): number {
  const db = getDb()
  const result = db.prepare(`
    UPDATE sessions
    SET analysis_status = 'skipped'
    WHERE analysis_status = 'pending'
      AND recorded_at < datetime('now', ? || ' days')
  `).run(`-${pendingTtlDays}`)
  return result.changes
}

/**
 * Clear all pending sessions (explicit user action).
 */
export function clearPendingSessions(): number {
  const db = getDb()
  const result = db.prepare(`
    UPDATE sessions
    SET analysis_status = 'skipped'
    WHERE analysis_status = 'pending'
  `).run()
  return result.changes
}

/**
 * Sync promoted flag from disk: if promoted=TRUE but file doesn't exist, set to FALSE.
 */
export function getPromotedKnowledge(): KnowledgeRow[] {
  const db = getDb()
  return db.prepare(`
    SELECT * FROM knowledge WHERE promoted = TRUE
  `).all() as KnowledgeRow[]
}

/**
 * Set promoted flag to FALSE for a knowledge item.
 */
export function demoteKnowledge(id: number): void {
  const db = getDb()
  db.prepare(`
    UPDATE knowledge SET promoted = FALSE, updated_at = datetime('now')
    WHERE id = ?
  `).run(id)
}

/**
 * Set promoted flag to TRUE for a knowledge item.
 */
export function promoteKnowledge(id: number): void {
  const db = getDb()
  db.prepare(`
    UPDATE knowledge SET promoted = TRUE, updated_at = datetime('now')
    WHERE id = ?
  `).run(id)
}

/**
 * Invalidate knowledge: set confidence to 0.0.
 */
export function invalidateKnowledge(id: number, reason: string): void {
  const db = getDb()
  db.prepare(`
    UPDATE knowledge
    SET confidence_score = 0.0,
        updated_at = datetime('now')
    WHERE id = ?
  `).run(id)
}

/**
 * Confirm knowledge: reset confidence to 1.0.
 */
export function confirmKnowledge(id: number): void {
  const db = getDb()
  db.prepare(`
    UPDATE knowledge
    SET confidence_score = 1.0,
        updated_at = datetime('now')
    WHERE id = ?
  `).run(id)
}

/**
 * Get knowledge by ID.
 */
export function getKnowledgeById(id: number): KnowledgeRow | undefined {
  const db = getDb()
  return db.prepare('SELECT * FROM knowledge WHERE id = ?').get(id) as KnowledgeRow | undefined
}

/**
 * List stale (unreferenced, low-hit) knowledge.
 */
export function listStaleKnowledge(daysUnused = 90): KnowledgeRow[] {
  const db = getDb()
  return db.prepare(`
    SELECT * FROM knowledge
    WHERE promoted = FALSE
      AND reference_count = 0
      AND updated_at < datetime('now', ? || ' days')
    ORDER BY updated_at ASC
    LIMIT 50
  `).all(`-${daysUnused}`) as KnowledgeRow[]
}

/**
 * Get monthly cost.
 */
export function getMonthlyCostForProject(project?: string): {
  session_count: number
  total_input_tokens: number
  total_output_tokens: number
  total_cost_usd: number
} {
  const db = getDb()
  return db.prepare(`
    SELECT
      COUNT(*) as session_count,
      COALESCE(SUM(input_tokens), 0) as total_input_tokens,
      COALESCE(SUM(output_tokens), 0) as total_output_tokens,
      COALESCE(SUM(cost_usd), 0) as total_cost_usd
    FROM sessions
    WHERE analyzed_at >= datetime('now', 'start of month')
      ${project ? 'AND project = ?' : ''}
  `).get(...(project ? [project] : [])) as {
    session_count: number
    total_input_tokens: number
    total_output_tokens: number
    total_cost_usd: number
  }
}
