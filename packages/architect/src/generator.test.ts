import { describe, it, expect } from 'vitest'
import { slugify, sanitizeFrontmatter } from './generator.js'

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

  it('never produces double dashes', () => {
    const titles = [
      'Docker起動手順',
      'Fix: Bug--in--code',
      'Test - - case',
      '   spaced   title   ',
    ]
    for (const title of titles) {
      const slug = slugify(title)
      expect(slug).not.toMatch(/--/)
    }
  })

  it('produces valid kebab-case (no uppercase, no spaces, no underscores)', () => {
    const slug = slugify('Docker_Setup Guide')
    expect(slug).not.toMatch(/[A-Z_ ]/)
  })
})

describe('sanitizeFrontmatter', () => {
  it('strips XML angle brackets from frontmatter', () => {
    const input = `---
name: test-skill
description: Handles <script> injection and <div> tags
---

# Body with <html> is fine`

    const result = sanitizeFrontmatter(input)
    expect(result).toContain('description: Handles script injection and div tags')
    expect(result).toContain('# Body with <html> is fine')
  })

  it('returns content unchanged if no frontmatter', () => {
    const input = '# No frontmatter here\nSome <html> content'
    expect(sanitizeFrontmatter(input)).toBe(input)
  })

  it('handles frontmatter without angle brackets', () => {
    const input = `---
name: clean-skill
description: No brackets here
---

# Body`

    expect(sanitizeFrontmatter(input)).toBe(input)
  })
})
