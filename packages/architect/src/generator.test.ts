import { describe, it, expect } from 'vitest'
import { slugify } from './generator.js'

describe('slugify', () => {
  it('converts English titles to slugs with hash suffix', () => {
    const slug = slugify('Docker Setup Guide')
    expect(slug).toMatch(/^docker-setup-guide-[0-9a-f]{6}$/)
  })

  it('handles Japanese titles (non-ASCII removed, hash preserved)', () => {
    const slug = slugify('Docker起動手順')
    expect(slug).toMatch(/^docker-[0-9a-f]{6}$/)
  })

  it('handles pure Japanese titles (slug is hash only)', () => {
    const slug = slugify('起動手順')
    expect(slug).toMatch(/^[0-9a-f]{6}$/)
  })

  it('produces deterministic output', () => {
    expect(slugify('Test')).toBe(slugify('Test'))
  })

  it('produces unique slugs for different titles', () => {
    expect(slugify('Docker setup')).not.toBe(slugify('React setup'))
  })

  it('handles special characters', () => {
    const slug = slugify('Fix: memory leak #123')
    expect(slug).toMatch(/^fix-memory-leak-123-[0-9a-f]{6}$/)
  })
})
