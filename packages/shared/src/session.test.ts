import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { resolveSessionId, resolveProjectName, truncateToTokenLimit } from './session.js'

describe('resolveSessionId', () => {
  const originalEnv = process.env

  beforeEach(() => {
    process.env = { ...originalEnv }
  })

  afterEach(() => {
    process.env = originalEnv
  })

  it('uses CLAUDE_SESSION_ID env var when available', () => {
    process.env['CLAUDE_SESSION_ID'] = 'test-session-123'
    expect(resolveSessionId()).toBe('test-session-123')
  })

  it('generates a UUID when no session ID is available', () => {
    delete process.env['CLAUDE_SESSION_ID']
    const id = resolveSessionId()
    // UUID v4 format
    expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/)
  })
})

describe('resolveProjectName', () => {
  const originalEnv = process.env

  beforeEach(() => {
    process.env = { ...originalEnv }
  })

  afterEach(() => {
    process.env = originalEnv
  })

  it('uses CLAUDE_PROJECT_NAME env var when available', () => {
    process.env['CLAUDE_PROJECT_NAME'] = 'my-project'
    expect(resolveProjectName()).toBe('my-project')
  })

  it('falls back to basename of cwd', () => {
    delete process.env['CLAUDE_PROJECT_NAME']
    const name = resolveProjectName()
    expect(name).toBeTruthy()
    expect(typeof name).toBe('string')
  })
})

describe('truncateToTokenLimit', () => {
  it('returns text as-is when under limit', () => {
    expect(truncateToTokenLimit('short text', 100)).toBe('short text')
  })

  it('truncates and prepends marker when over limit', () => {
    const longText = 'A'.repeat(100)
    const result = truncateToTokenLimit(longText, 50)
    expect(result).toContain('[前略...]')
    expect(result.length).toBeLessThanOrEqual(50 + '[前略...]\n'.length)
  })

  it('preserves the end of the text (most relevant)', () => {
    const text = 'START' + 'X'.repeat(100) + 'END'
    const result = truncateToTokenLimit(text, 10)
    expect(result).toContain('END')
    expect(result).not.toContain('START')
  })
})
