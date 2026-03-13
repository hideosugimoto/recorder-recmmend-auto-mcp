import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import * as path from 'node:path'
import * as os from 'node:os'
import * as fs from 'node:fs'
import { initDb, closeDb, saveRawLog, saveAnalysis, getDb } from '@claude-memory/shared'
import { detectCandidates, formatProposals } from './detector.js'

let testDbPath: string

beforeEach(() => {
  testDbPath = path.join(os.tmpdir(), `test-detector-${Date.now()}-${Math.random().toString(36).slice(2)}.db`)
  initDb(testDbPath)
})

afterEach(() => {
  closeDb()
  try { fs.unlinkSync(testDbPath) } catch { /* ignore */ }
  try { fs.unlinkSync(testDbPath + '-wal') } catch { /* ignore */ }
  try { fs.unlinkSync(testDbPath + '-shm') } catch { /* ignore */ }
})

function ensureSession() {
  const db = getDb()
  db.prepare(`INSERT OR IGNORE INTO sessions (id, project, analysis_status) VALUES ('s1', 'test-project', 'completed')`).run()
}

function seedKnowledge(hitCount: number, category = 'skills', title = 'Docker setup') {
  ensureSession()
  const db = getDb()

  db.prepare(`
    INSERT INTO knowledge (session_id, project, category, title, content, tags, hit_count, confidence_score, promoted)
    VALUES (?, ?, ?, ?, ?, ?, ?, 1.0, FALSE)
  `).run('s1', 'test-project', category, title, 'content', '["docker"]', hitCount)
}

describe('detectCandidates', () => {
  it('returns candidates with hit_count >= threshold', () => {
    seedKnowledge(3)
    const candidates = detectCandidates(3, 'test-project')
    expect(candidates).toHaveLength(1)
    expect(candidates[0].title).toBe('Docker setup')
  })

  it('excludes candidates below threshold', () => {
    seedKnowledge(2)
    const candidates = detectCandidates(3, 'test-project')
    expect(candidates).toHaveLength(0)
  })

  it('excludes promoted knowledge', () => {
    ensureSession()
    const db = getDb()
    db.prepare(`
      INSERT INTO knowledge (session_id, project, category, title, content, tags, hit_count, confidence_score, promoted)
      VALUES (?, ?, ?, ?, ?, ?, ?, 1.0, TRUE)
    `).run('s1', 'test-project', 'skills', 'Already promoted', 'content', '[]', 5)

    const candidates = detectCandidates(3, 'test-project')
    expect(candidates).toHaveLength(0)
  })

  it('excludes low confidence knowledge', () => {
    ensureSession()
    const db = getDb()
    db.prepare(`
      INSERT INTO knowledge (session_id, project, category, title, content, tags, hit_count, confidence_score, promoted)
      VALUES (?, ?, ?, ?, ?, ?, ?, 0.3, FALSE)
    `).run('s1', 'test-project', 'skills', 'Low confidence', 'content', '[]', 5)

    const candidates = detectCandidates(3, 'test-project')
    expect(candidates).toHaveLength(0)
  })

  it('maps suggestedAction from category', () => {
    seedKnowledge(3, 'mcp', 'API automation')
    seedKnowledge(3, 'rule', 'Project rule')
    seedKnowledge(3, 'skills', 'Skill item')

    const candidates = detectCandidates(3, 'test-project')
    const actions = candidates.map(c => ({ title: c.title, action: c.suggestedAction }))

    expect(actions.find(a => a.title === 'API automation')?.action).toBe('generate_mcp')
    expect(actions.find(a => a.title === 'Project rule')?.action).toBe('propose_claude_md')
    expect(actions.find(a => a.title === 'Skill item')?.action).toBe('generate_skill')
  })
})

describe('formatProposals', () => {
  it('returns empty string for no candidates', () => {
    expect(formatProposals([])).toBe('')
  })

  it('formats candidates for display', () => {
    seedKnowledge(5)
    const candidates = detectCandidates(3, 'test-project')
    const formatted = formatProposals(candidates)
    expect(formatted).toContain('Docker setup')
    expect(formatted).toContain('5回検出')
  })
})
