import { describe, it, expect } from 'vitest'
import { slugify, sanitizeFrontmatter, SKILL_PROMPT, ALLOWED_TOOLS_BY_CATEGORY, parseTestQueries } from './generator.js'

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

// === Improvement 2: allowed-tools by category ===
describe('SKILL_PROMPT - allowed-tools', () => {
  it('includes allowed-tools field in the frontmatter template', () => {
    expect(SKILL_PROMPT).toContain('allowed-tools')
  })

  it('references category-specific allowed-tools defaults', () => {
    // The prompt should mention category-based allowed-tools assignment
    expect(SKILL_PROMPT).toMatch(/allowed-tools/)
  })
})

describe('ALLOWED_TOOLS_BY_CATEGORY', () => {
  it('maps skills category to empty string (built-in only)', () => {
    expect(ALLOWED_TOOLS_BY_CATEGORY.skills).toBe('')
  })

  it('maps mcp category to Bash(node:*) WebFetch', () => {
    expect(ALLOWED_TOOLS_BY_CATEGORY.mcp).toBe('Bash(node:*) WebFetch')
  })

  it('maps debug category to Bash(*)', () => {
    expect(ALLOWED_TOOLS_BY_CATEGORY.debug).toBe('Bash(*)')
  })

  it('maps workflow category to empty string', () => {
    expect(ALLOWED_TOOLS_BY_CATEGORY.workflow).toBe('')
  })

  it('maps rule category to empty string', () => {
    expect(ALLOWED_TOOLS_BY_CATEGORY.rule).toBe('')
  })

  it('covers all 5 knowledge categories', () => {
    const categories = ['skills', 'mcp', 'debug', 'workflow', 'rule'] as const
    for (const cat of categories) {
      expect(ALLOWED_TOOLS_BY_CATEGORY).toHaveProperty(cat)
    }
  })
})

// === Improvement 3: negative trigger in description ===
describe('SKILL_PROMPT - negative trigger', () => {
  it('instructs to include negative triggers in description', () => {
    // The prompt should tell the AI to add "Do NOT use for" clauses
    expect(SKILL_PROMPT).toMatch(/Do NOT use for/i)
  })

  it('mentions over-triggering prevention', () => {
    expect(SKILL_PROMPT).toMatch(/over-trigger|unrelated|not.*relevant/i)
  })
})

// === Improvement 4: test query generation ===
describe('parseTestQueries', () => {
  it('extracts test queries JSON block from generated content', () => {
    const content = `---
name: test-skill
description: A test skill
---

# Test Skill

## Instructions
Do something.

<!-- TEST_QUERIES
{
  "shouldTrigger": ["how to setup docker", "docker compose help"],
  "shouldNotTrigger": ["how to cook pasta", "weather forecast"]
}
-->`

    const result = parseTestQueries(content)
    expect(result.shouldTrigger).toEqual(['how to setup docker', 'docker compose help'])
    expect(result.shouldNotTrigger).toEqual(['how to cook pasta', 'weather forecast'])
  })

  it('returns empty arrays when no test queries block found', () => {
    const content = `---
name: test-skill
description: A test skill
---

# No test queries here`

    const result = parseTestQueries(content)
    expect(result.shouldTrigger).toEqual([])
    expect(result.shouldNotTrigger).toEqual([])
  })

  it('returns empty arrays for malformed JSON in test queries block', () => {
    const content = `---
name: test-skill
description: A test skill
---

<!-- TEST_QUERIES
{ invalid json }
-->`

    const result = parseTestQueries(content)
    expect(result.shouldTrigger).toEqual([])
    expect(result.shouldNotTrigger).toEqual([])
  })

  it('strips the test queries block from content', () => {
    const content = `---
name: test-skill
---

# Body

<!-- TEST_QUERIES
{
  "shouldTrigger": ["query1"],
  "shouldNotTrigger": ["query2"]
}
-->`

    const result = parseTestQueries(content)
    expect(result.cleanContent).not.toContain('TEST_QUERIES')
    expect(result.cleanContent).toContain('# Body')
  })
})

describe('SKILL_PROMPT - test queries generation', () => {
  it('instructs to generate test queries in the output', () => {
    expect(SKILL_PROMPT).toContain('TEST_QUERIES')
  })

  it('instructs to include shouldTrigger and shouldNotTrigger', () => {
    expect(SKILL_PROMPT).toContain('shouldTrigger')
    expect(SKILL_PROMPT).toContain('shouldNotTrigger')
  })
})
