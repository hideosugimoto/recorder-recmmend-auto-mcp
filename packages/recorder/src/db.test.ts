import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import * as path from 'node:path'
import * as os from 'node:os'
import * as fs from 'node:fs'
import { initDb, closeDb, saveRawLog, saveAnalysis, getDb } from '@claude-memory/shared'
import { upsertKnowledge, searchKnowledge, reviewKnowledge, listSessions, showCost } from './db.js'

let testDbPath: string

beforeEach(() => {
  testDbPath = path.join(os.tmpdir(), `test-recorder-db-${Date.now()}-${Math.random().toString(36).slice(2)}.db`)
  initDb(testDbPath)
  // Seed a session for FK
  saveRawLog('s1', 'a'.repeat(600), 'test-project')
})

afterEach(() => {
  closeDb()
  try { fs.unlinkSync(testDbPath) } catch { /* ignore */ }
  try { fs.unlinkSync(testDbPath + '-wal') } catch { /* ignore */ }
  try { fs.unlinkSync(testDbPath + '-shm') } catch { /* ignore */ }
})

describe('upsertKnowledge', () => {
  it('inserts new knowledge', () => {
    const result = upsertKnowledge('s1', 'test-project', {
      category: 'skills',
      title: 'Docker setup',
      content: 'How to set up Docker',
      tags: ['docker'],
    })
    expect(result.action).toBe('insert')
    expect(result.id).toBeGreaterThan(0)
  })

  it('updates existing knowledge on similar title (hit_count+1)', () => {
    upsertKnowledge('s1', 'test-project', {
      category: 'skills',
      title: 'Docker setup',
      content: 'v1',
      tags: ['docker'],
    })
    const result = upsertKnowledge('s1', 'test-project', {
      category: 'skills',
      title: 'Docker setup',
      content: 'v2',
      tags: ['docker', 'updated'],
    })
    expect(result.action).toBe('update')

    const db = getDb()
    const row = db.prepare("SELECT * FROM knowledge WHERE title = 'Docker setup'").get() as Record<string, unknown>
    expect(row.hit_count).toBe(2)
    expect(row.content).toBe('v2')
  })

  it('protects promoted knowledge content from overwrite', () => {
    const { id } = upsertKnowledge('s1', 'test-project', {
      category: 'skills',
      title: 'Docker setup',
      content: 'original',
      tags: ['docker'],
    })

    const db = getDb()
    db.prepare('UPDATE knowledge SET promoted = TRUE WHERE id = ?').run(id)

    upsertKnowledge('s1', 'test-project', {
      category: 'skills',
      title: 'Docker setup',
      content: 'should not overwrite',
      tags: ['new-tag'],
    })

    const row = db.prepare('SELECT * FROM knowledge WHERE id = ?').get(id) as Record<string, unknown>
    expect(row.content).toBe('original')
    expect(row.hit_count).toBe(2)
  })
})

describe('searchKnowledge', () => {
  it('finds knowledge by title', () => {
    upsertKnowledge('s1', 'test-project', {
      category: 'skills',
      title: 'Docker setup',
      content: 'Docker instructions',
      tags: ['docker'],
    })
    const results = searchKnowledge('Docker', 'test-project')
    expect(results.length).toBe(1)
    expect(results[0].title).toBe('Docker setup')
  })

  it('finds knowledge by content', () => {
    upsertKnowledge('s1', 'test-project', {
      category: 'debug',
      title: 'Memory leak',
      content: 'Use valgrind to detect memory leaks',
      tags: ['debug'],
    })
    const results = searchKnowledge('valgrind', 'test-project')
    expect(results.length).toBe(1)
  })

  it('increments reference_count on search', () => {
    upsertKnowledge('s1', 'test-project', {
      category: 'skills',
      title: 'Docker setup',
      content: 'content',
      tags: [],
    })
    searchKnowledge('Docker', 'test-project')
    searchKnowledge('Docker', 'test-project')

    const db = getDb()
    const row = db.prepare("SELECT reference_count FROM knowledge WHERE title = 'Docker setup'").get() as Record<string, unknown>
    expect(row.reference_count).toBe(2)
  })

  it('excludes low confidence knowledge', () => {
    const { id } = upsertKnowledge('s1', 'test-project', {
      category: 'skills',
      title: 'Bad knowledge',
      content: 'low confidence content',
      tags: [],
    })
    const db = getDb()
    db.prepare('UPDATE knowledge SET confidence_score = 0.3 WHERE id = ?').run(id)

    const results = searchKnowledge('Bad', 'test-project')
    expect(results.length).toBe(0)
  })
})

describe('reviewKnowledge', () => {
  it('returns specific knowledge by ID', () => {
    const { id } = upsertKnowledge('s1', 'test-project', {
      category: 'skills',
      title: 'Test item',
      content: 'content',
      tags: [],
    })
    const results = reviewKnowledge(id)
    expect(results.length).toBe(1)
    expect(results[0].title).toBe('Test item')
  })

  it('returns low confidence items when no ID given', () => {
    const { id } = upsertKnowledge('s1', 'test-project', {
      category: 'skills',
      title: 'Low conf item',
      content: 'content',
      tags: [],
    })
    const db = getDb()
    db.prepare('UPDATE knowledge SET confidence_score = 0.5 WHERE id = ?').run(id)

    const results = reviewKnowledge()
    expect(results.length).toBe(1)
    expect(results[0].title).toBe('Low conf item')
  })
})

describe('listSessions', () => {
  it('returns recent sessions', () => {
    const sessions = listSessions(10)
    expect(sessions.length).toBeGreaterThanOrEqual(1)
  })
})

describe('showCost', () => {
  it('returns cost summary', () => {
    const cost = showCost('month')
    expect(cost).toHaveProperty('session_count')
    expect(cost).toHaveProperty('total_cost_usd')
  })
})
