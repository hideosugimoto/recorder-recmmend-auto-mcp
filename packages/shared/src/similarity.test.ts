import { describe, it, expect } from 'vitest'
import { findByLevenshtein } from './similarity.js'

describe('findByLevenshtein', () => {
  it('finds exact match', () => {
    const result = findByLevenshtein('Docker setup', [
      { id: 1, title: 'Docker setup' },
      { id: 2, title: 'React hooks' },
    ])
    expect(result).toEqual({ id: 1, title: 'Docker setup' })
  })

  it('finds similar match (case insensitive)', () => {
    const result = findByLevenshtein('docker Setup', [
      { id: 1, title: 'Docker setup' },
    ])
    expect(result).toEqual({ id: 1, title: 'Docker setup' })
  })

  it('finds similar match with small edit distance', () => {
    const result = findByLevenshtein('Docker setups', [
      { id: 1, title: 'Docker setup' },
    ])
    expect(result).toEqual({ id: 1, title: 'Docker setup' })
  })

  it('returns null for completely different titles', () => {
    const result = findByLevenshtein('React hooks', [
      { id: 1, title: 'Docker setup' },
      { id: 2, title: 'Python debugging' },
    ])
    expect(result).toBeNull()
  })

  it('returns null for empty candidates', () => {
    const result = findByLevenshtein('Docker setup', [])
    expect(result).toBeNull()
  })

  it('returns the best match among multiple similar candidates', () => {
    const result = findByLevenshtein('Docker setup guide', [
      { id: 1, title: 'Docker setup' },
      { id: 2, title: 'Docker setup guide v2' },
    ])
    // 'Docker setup guide v2' is closer to 'Docker setup guide'
    expect(result?.id).toBe(2)
  })

  it('handles Japanese titles', () => {
    const result = findByLevenshtein('Docker起動手順', [
      { id: 1, title: 'Docker起動手順' },
      { id: 2, title: 'React開発フロー' },
    ])
    expect(result).toEqual({ id: 1, title: 'Docker起動手順' })
  })

  it('rejects titles that are too different (>30% edit distance)', () => {
    const result = findByLevenshtein('ABCDEFGHIJ', [
      { id: 1, title: 'XYZWVUTSRQ' },
    ])
    expect(result).toBeNull()
  })
})
