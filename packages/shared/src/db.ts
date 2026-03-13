import Database from 'better-sqlite3'
import * as path from 'node:path'
import * as os from 'node:os'
import * as fs from 'node:fs'
import * as crypto from 'node:crypto'
import type { AnalysisResult, KnowledgeItem, PatternItem, SessionRow, KnowledgeRow } from './types.js'
import { findByLevenshtein } from './similarity.js'

const SCHEMA_VERSION = 1
const DEFAULT_DB_DIR = path.join(os.homedir(), '.claude-memory')
const DEFAULT_DB_PATH = path.join(DEFAULT_DB_DIR, 'memory.db')

let db: Database.Database | null = null

export function getDb(): Database.Database {
  if (!db) {
    throw new Error('Database not initialized. Call initDb() first.')
  }
  return db
}

export function initDb(dbPath?: string): Database.Database {
  const resolvedPath = dbPath ?? process.env['DB_PATH'] ?? DEFAULT_DB_PATH
  const dir = path.dirname(resolvedPath)
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true })
  }

  db = new Database(resolvedPath)
  db.pragma('journal_mode = WAL')
  db.pragma('busy_timeout = 5000')
  db.pragma('foreign_keys = ON')

  runMigrations(db)
  return db
}

export function closeDb(): void {
  if (db) {
    db.close()
    db = null
  }
}

function runMigrations(database: Database.Database): void {
  const currentVersion = database.pragma('user_version', { simple: true }) as number

  if (currentVersion < SCHEMA_VERSION) {
    database.exec(`
      CREATE TABLE IF NOT EXISTS sessions (
        id               TEXT PRIMARY KEY,
        recorded_at      DATETIME,
        analyzed_at      DATETIME,
        project          TEXT,
        summary          TEXT,
        raw_analysis     TEXT,
        raw_log          TEXT,
        analysis_status  TEXT DEFAULT 'pending',
        input_tokens     INTEGER DEFAULT 0,
        output_tokens    INTEGER DEFAULT 0,
        cost_usd         REAL    DEFAULT 0.0,
        created_at       DATETIME DEFAULT CURRENT_TIMESTAMP
      );

      CREATE TABLE IF NOT EXISTS knowledge (
        id                   INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id           TEXT REFERENCES sessions(id) ON DELETE SET NULL,
        project              TEXT,
        category             TEXT,
        title                TEXT,
        content              TEXT,
        tags                 TEXT,
        hit_count            INTEGER DEFAULT 1,
        reference_count      INTEGER DEFAULT 0,
        last_referenced_at   DATETIME,
        confidence_score     REAL DEFAULT 1.0,
        promoted             BOOLEAN DEFAULT FALSE,
        created_at           DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at           DATETIME DEFAULT CURRENT_TIMESTAMP
      );

      CREATE TABLE IF NOT EXISTS patterns (
        id               INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id       TEXT,
        pattern_hash     TEXT UNIQUE,
        description      TEXT,
        occurrences      INTEGER DEFAULT 1,
        initial_estimate INTEGER,
        last_seen        DATETIME,
        category         TEXT
      );

      CREATE INDEX IF NOT EXISTS idx_knowledge_title    ON knowledge(title);
      CREATE INDEX IF NOT EXISTS idx_knowledge_category ON knowledge(category);
      CREATE INDEX IF NOT EXISTS idx_knowledge_project  ON knowledge(project);
      CREATE INDEX IF NOT EXISTS idx_sessions_status    ON sessions(analysis_status);
    `)

    database.pragma(`user_version = ${SCHEMA_VERSION}`)
  }
}

/**
 * Save raw session log (Phase 1: Stop hook).
 * Inserts a new session with analysis_status='pending'.
 */
export function saveRawLog(sessionId: string, rawLog: string, project: string): void {
  const database = getDb()
  const stmt = database.prepare(`
    INSERT OR IGNORE INTO sessions (id, raw_log, project, recorded_at, analysis_status)
    VALUES (?, ?, ?, datetime('now'), 'pending')
  `)
  stmt.run(sessionId, rawLog, project)
}

/**
 * Save analysis results (Phase 2: PreToolUse hook).
 * Transaction: UPDATE sessions → upsert knowledge × N → upsert patterns × M.
 * Must be atomic to prevent inconsistent state.
 */
export function saveAnalysis(
  sessionId: string,
  result: AnalysisResult,
  project: string,
  tokenUsage?: { inputTokens: number; outputTokens: number; costUsd: number }
): void {
  const database = getDb()

  const transaction = database.transaction(() => {
    // Update session
    database.prepare(`
      UPDATE sessions
      SET analysis_status = 'completed',
          analyzed_at = datetime('now'),
          summary = ?,
          raw_analysis = ?,
          input_tokens = ?,
          output_tokens = ?,
          cost_usd = ?
      WHERE id = ?
    `).run(
      result.summary,
      JSON.stringify(result),
      tokenUsage?.inputTokens ?? 0,
      tokenUsage?.outputTokens ?? 0,
      tokenUsage?.costUsd ?? 0,
      sessionId
    )

    // Upsert knowledge items
    for (const item of result.knowledge) {
      upsertKnowledgeInternal(database, sessionId, project, item)
    }

    // Upsert patterns
    for (const pattern of result.patterns) {
      upsertPatternInternal(database, sessionId, pattern)
    }
  })

  transaction()
}

function upsertKnowledgeInternal(
  database: Database.Database,
  sessionId: string,
  project: string,
  item: KnowledgeItem
): void {
  // Check for existing similar title
  const existing = database.prepare(`
    SELECT id, title, promoted, confidence_score FROM knowledge
    WHERE project = ? AND category = ?
    ORDER BY hit_count DESC
  `).all(project, item.category) as Array<{ id: number; title: string; promoted: number; confidence_score: number }>

  const match = findByLevenshtein(item.title, existing.map(e => ({ id: e.id, title: e.title })))

  if (match) {
    const matchedRow = existing.find(e => e.id === match.id)
    if (matchedRow && matchedRow.promoted) {
      // promoted=TRUE: only update hit_count and confidence_score
      database.prepare(`
        UPDATE knowledge
        SET hit_count = hit_count + 1,
            updated_at = datetime('now')
        WHERE id = ?
      `).run(match.id)
    } else {
      // promoted=FALSE: update content/tags and increment hit_count
      database.prepare(`
        UPDATE knowledge
        SET hit_count = hit_count + 1,
            content = ?,
            tags = ?,
            session_id = ?,
            updated_at = datetime('now')
        WHERE id = ?
      `).run(item.content, JSON.stringify(item.tags), sessionId, match.id)
    }
  } else {
    // New knowledge
    database.prepare(`
      INSERT INTO knowledge (session_id, project, category, title, content, tags)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(sessionId, project, item.category, item.title, item.content, JSON.stringify(item.tags))
  }
}

function upsertPatternInternal(
  database: Database.Database,
  sessionId: string,
  pattern: PatternItem
): void {
  const hash = crypto.createHash('sha256')
    .update(pattern.description.toLowerCase().trim())
    .digest('hex')
    .slice(0, 16)

  const existing = database.prepare(`
    SELECT id FROM patterns WHERE pattern_hash = ?
  `).get(hash) as { id: number } | undefined

  if (existing) {
    database.prepare(`
      UPDATE patterns
      SET occurrences = occurrences + 1,
          last_seen = datetime('now')
      WHERE pattern_hash = ?
    `).run(hash)
  } else {
    database.prepare(`
      INSERT INTO patterns (session_id, pattern_hash, description, occurrences, initial_estimate, last_seen, category)
      VALUES (?, ?, ?, 1, ?, datetime('now'), ?)
    `).run(sessionId, hash, pattern.description, pattern.occurrences, pattern.category)
  }
}

/**
 * Clean up raw_log after successful analysis to save space.
 */
export function cleanupAfterAnalysis(sessionId: string): void {
  const database = getDb()
  database.prepare(`
    UPDATE sessions SET raw_log = NULL WHERE id = ? AND analysis_status = 'completed'
  `).run(sessionId)
}

/**
 * Get pending sessions for a project.
 */
export function getPendingSessions(project: string, limit = 3): SessionRow[] {
  const database = getDb()
  return database.prepare(`
    SELECT * FROM sessions
    WHERE analysis_status = 'pending'
      AND (project = ? OR project IS NULL)
    ORDER BY recorded_at ASC
    LIMIT ?
  `).all(project, limit) as SessionRow[]
}

/**
 * Optimistic lock: attempt to transition pending → processing.
 * Returns true if this process won the lock.
 */
export function acquireAnalysisLock(sessionId: string): boolean {
  const database = getDb()
  const result = database.prepare(`
    UPDATE sessions
    SET analysis_status = 'processing'
    WHERE id = ? AND analysis_status = 'pending'
  `).run(sessionId)
  return result.changes > 0
}

/**
 * Mark session as failed (will be retried next time).
 */
export function markAnalysisFailed(sessionId: string): void {
  const database = getDb()
  database.prepare(`
    UPDATE sessions SET analysis_status = 'failed' WHERE id = ?
  `).run(sessionId)
}

/**
 * Mark session as skipped (terminal state).
 */
export function markAnalysisSkipped(sessionId: string): void {
  const database = getDb()
  database.prepare(`
    UPDATE sessions SET analysis_status = 'skipped' WHERE id = ?
  `).run(sessionId)
}

/**
 * Reset failed sessions back to pending for retry.
 */
export function resetFailedToPending(project: string): number {
  const database = getDb()
  const result = database.prepare(`
    UPDATE sessions
    SET analysis_status = 'pending'
    WHERE analysis_status = 'failed'
      AND (project = ? OR project IS NULL)
  `).run(project)
  return result.changes
}

/**
 * Run retention cleanup: delete old sessions and patterns.
 */
export function runRetentionCleanup(retentionDays = 90, patternRetentionDays = 180): void {
  const database = getDb()
  database.transaction(() => {
    // Delete old completed sessions (ON DELETE SET NULL preserves knowledge)
    database.prepare(`
      DELETE FROM sessions
      WHERE analysis_status = 'completed'
        AND created_at < datetime('now', ? || ' days')
    `).run(`-${retentionDays}`)

    // Delete old patterns
    database.prepare(`
      DELETE FROM patterns
      WHERE last_seen < datetime('now', ? || ' days')
    `).run(`-${patternRetentionDays}`)

    // Delete stale unpromoted, unreferenced knowledge
    database.prepare(`
      DELETE FROM knowledge
      WHERE promoted = FALSE
        AND reference_count = 0
        AND hit_count < 3
        AND updated_at < datetime('now', ? || ' days')
    `).run(`-${retentionDays}`)
  })()
}

/**
 * Check DB file size and warn if too large.
 */
export function checkDbSize(dbPath?: string): { sizeBytes: number; warning: boolean } {
  const resolvedPath = dbPath ?? process.env['DB_PATH'] ?? DEFAULT_DB_PATH
  try {
    const stats = fs.statSync(resolvedPath)
    const WARNING_THRESHOLD = 100 * 1024 * 1024 // 100MB
    return {
      sizeBytes: stats.size,
      warning: stats.size > WARNING_THRESHOLD,
    }
  } catch {
    return { sizeBytes: 0, warning: false }
  }
}

/**
 * Get monthly cost for a project.
 */
export function getMonthlyCost(project?: string): number {
  const database = getDb()
  const row = database.prepare(`
    SELECT COALESCE(SUM(cost_usd), 0) as total
    FROM sessions
    WHERE analyzed_at >= datetime('now', 'start of month')
      ${project ? 'AND project = ?' : ''}
  `).get(...(project ? [project] : [])) as { total: number }
  return row.total
}
