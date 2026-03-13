import Anthropic from '@anthropic-ai/sdk'
import * as crypto from 'node:crypto'
import * as path from 'node:path'
import * as fs from 'node:fs'
import { type KnowledgeRow, getDb } from '@claude-memory/shared'
import { auditGeneratedCode } from './auditor.js'
import { promoteKnowledge, getKnowledgeById } from './db.js'

const GENERATOR_TIMEOUT = 30000

function getGeneratorModel(): string {
  return process.env['CLAUDE_MEMORY_GENERATOR_MODEL']
    ?? process.env['CLAUDE_MEMORY_MODEL']
    ?? 'claude-sonnet-4-6'
}

/**
 * Generate a URL-safe slug from a title.
 * Appends SHA-256 hash suffix to prevent collisions (especially for Japanese titles).
 * e.g., "Docker Setup Guide" → "docker-setup-guide-a3f9c1"
 * e.g., "Docker起動手順" → "docker-a3f9c1" (Japanese chars removed, hash preserved)
 * e.g., "起動手順" → "a3f9c1" (pure non-ASCII → hash only)
 */
export function slugify(title: string): string {
  const hash = crypto.createHash('sha256')
    .update(title)
    .digest('hex')
    .slice(0, 6)

  const slug = title
    .toLowerCase()
    .replace(/[^\w\s-]/g, '')
    .replace(/[\s_]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')

  return slug ? `${slug}-${hash}` : hash
}

const SKILL_PROMPT = `You are generating a SKILL.md file for Claude Code. Follow the official Skills specification exactly.

CRITICAL REQUIREMENTS:
1. Start with YAML frontmatter delimited by --- lines
2. The "name" field MUST be the exact value: {slug}
3. The "description" field MUST include BOTH:
   - WHAT: What this skill does (1 sentence)
   - WHEN: Specific trigger phrases users would say (e.g., "Use when user says X, Y, or Z")
4. Description must be under 1024 characters
5. NEVER use XML angle brackets (< or >) in frontmatter — this is a security restriction
6. Keep the SKILL.md body under 5,000 words — move detailed references to a separate section marked "See references/ for details"

Generate a SKILL.md with this structure:

---
name: {slug}
description: [WHAT it does]. Use when user says "[trigger phrase 1]", "[trigger phrase 2]", or "[trigger phrase 3]".
metadata:
  author: claude-memory-kit
  version: "1.0"
  category: {category}
  tags: {tags_yaml}
---

# [Title]

## Instructions

### Step 1: [First Major Step]
[Clear, actionable instructions]

### Step 2: [Next Step]
[Continue as needed]

## Examples

Example 1: [Common scenario]
User says: "[example request]"
Actions: [what the skill does]
Result: [expected outcome]

## Troubleshooting

Error: [Common error]
Cause: [Why it happens]
Solution: [How to fix]

## References
[If the content is extensive, note: "See references/details.md for full documentation"]

---

Write in the same language as the input content.

Knowledge to convert:
Title: {title}
Category: {category}
Content: {content}
Tags: {tags}

Generate ONLY the SKILL.md content (frontmatter + body), no wrapping or explanation.`

const MCP_PROMPT = `You are generating a minimal MCP (Model Context Protocol) server in TypeScript.
The server should automate the following knowledge into a reusable tool.

Requirements:
- Use @modelcontextprotocol/sdk
- Use StdioServerTransport
- Include proper TypeScript types
- Include error handling
- Keep it minimal and focused

Knowledge to automate:
Title: {title}
Category: {category}
Content: {content}
Tags: {tags}

Generate ONLY the TypeScript code, no wrapping or explanation.`

/**
 * Build the SKILL.md generation prompt with all placeholders filled.
 */
function buildSkillPrompt(knowledge: KnowledgeRow): string {
  const slug = slugify(knowledge.title)
  const tags = parseTags(knowledge.tags)
  const tagsYaml = tags.length > 0
    ? `[${tags.map(t => t.replace(/[<>]/g, '')).join(', ')}]`
    : '[]'

  return SKILL_PROMPT
    .replace(/{slug}/g, slug)
    .replace('{title}', knowledge.title)
    .replace('{category}', knowledge.category)
    .replace('{content}', knowledge.content)
    .replace('{tags}', knowledge.tags)
    .replace('{tags_yaml}', tagsYaml)
}

/**
 * Parse JSON tags string, returning empty array on failure.
 */
function parseTags(tagsJson: string): string[] {
  try {
    const parsed = JSON.parse(tagsJson)
    return Array.isArray(parsed) ? parsed : []
  } catch {
    return []
  }
}

/**
 * Sanitize generated SKILL.md frontmatter: strip XML angle brackets from frontmatter section.
 * Exported for testing.
 */
export function sanitizeFrontmatter(content: string): string {
  const frontmatterMatch = content.match(/^---\n([\s\S]*?)\n---/)
  if (!frontmatterMatch) return content

  const sanitizedFm = frontmatterMatch[1].replace(/[<>]/g, '')
  return content.replace(frontmatterMatch[1], sanitizedFm)
}

/**
 * Generate a SKILL.md file from a knowledge item.
 * Follows the official Skills specification:
 * - YAML frontmatter with name (kebab-case) and description (WHAT + WHEN)
 * - Progressive disclosure: SKILL.md body + references/ directory
 */
export async function generateSkill(
  knowledgeId: number,
  outputPath?: string,
  apiKey?: string
): Promise<{ filePath: string; content: string }> {
  const knowledge = getKnowledgeById(knowledgeId)
  if (!knowledge) {
    throw new Error(`Knowledge ID ${knowledgeId} not found`)
  }

  // Skip if already promoted (unless force_regenerate)
  if (knowledge.promoted) {
    throw new Error(`Knowledge ID ${knowledgeId} is already promoted. Use force_regenerate_skill.`)
  }

  const key = apiKey ?? process.env['ANTHROPIC_API_KEY']
  if (!key) {
    throw new Error('ANTHROPIC_API_KEY not configured')
  }

  const client = new Anthropic({ apiKey: key })
  const prompt = buildSkillPrompt(knowledge)

  const response = await client.messages.create({
    model: getGeneratorModel(),
    max_tokens: 4096,
    temperature: 0,
    messages: [{ role: 'user', content: prompt }],
  }, {
    signal: AbortSignal.timeout(GENERATOR_TIMEOUT),
  })

  const textBlock = response.content.find(b => b.type === 'text')
  if (!textBlock || textBlock.type !== 'text') {
    throw new Error('No text response from API')
  }

  const sanitizedContent = sanitizeFrontmatter(textBlock.text)

  const slug = slugify(knowledge.title)
  const skillsDir = outputPath ?? process.env['SKILLS_OUTPUT_DIR'] ?? '.claude/skills'
  const skillDir = path.join(skillsDir, slug)
  const filePath = path.join(skillDir, 'SKILL.md')
  const refsDir = path.join(skillDir, 'references')

  // Create skill directory with references/ subdirectory (3-layer structure)
  fs.mkdirSync(refsDir, { recursive: true })
  fs.writeFileSync(filePath, sanitizedContent)

  // Mark as promoted
  promoteKnowledge(knowledgeId)

  return { filePath, content: sanitizedContent }
}

/**
 * Force regenerate a SKILL.md for an already-promoted knowledge item.
 */
export async function forceRegenerateSkill(
  knowledgeId: number,
  outputPath?: string,
  apiKey?: string
): Promise<{ filePath: string; content: string }> {
  const knowledge = getKnowledgeById(knowledgeId)
  if (!knowledge) {
    throw new Error(`Knowledge ID ${knowledgeId} not found`)
  }

  const key = apiKey ?? process.env['ANTHROPIC_API_KEY']
  if (!key) {
    throw new Error('ANTHROPIC_API_KEY not configured')
  }

  const client = new Anthropic({ apiKey: key })
  const prompt = buildSkillPrompt(knowledge)

  const response = await client.messages.create({
    model: getGeneratorModel(),
    max_tokens: 4096,
    temperature: 0,
    messages: [{ role: 'user', content: prompt }],
  }, {
    signal: AbortSignal.timeout(GENERATOR_TIMEOUT),
  })

  const textBlock = response.content.find(b => b.type === 'text')
  if (!textBlock || textBlock.type !== 'text') {
    throw new Error('No text response from API')
  }

  const sanitizedContent = sanitizeFrontmatter(textBlock.text)

  const slug = slugify(knowledge.title)
  const skillsDir = outputPath ?? process.env['SKILLS_OUTPUT_DIR'] ?? '.claude/skills'
  const skillDir = path.join(skillsDir, slug)
  const filePath = path.join(skillDir, 'SKILL.md')
  const refsDir = path.join(skillDir, 'references')

  fs.mkdirSync(refsDir, { recursive: true })
  fs.writeFileSync(filePath, sanitizedContent)

  // Ensure promoted
  promoteKnowledge(knowledgeId)

  return { filePath, content: sanitizedContent }
}

/**
 * Generate an MCP server from a knowledge item.
 * NEVER auto-writes to settings.json (design principle 4).
 */
export async function generateMcp(
  knowledgeId: number,
  language: 'typescript' | 'python' = 'typescript',
  apiKey?: string
): Promise<{ filePath: string; code: string; registrationSnippet: string }> {
  const knowledge = getKnowledgeById(knowledgeId)
  if (!knowledge) {
    throw new Error(`Knowledge ID ${knowledgeId} not found`)
  }

  const key = apiKey ?? process.env['ANTHROPIC_API_KEY']
  if (!key) {
    throw new Error('ANTHROPIC_API_KEY not configured')
  }

  const client = new Anthropic({ apiKey: key })
  const prompt = MCP_PROMPT
    .replace('{title}', knowledge.title)
    .replace('{category}', knowledge.category)
    .replace('{content}', knowledge.content)
    .replace('{tags}', knowledge.tags)

  const response = await client.messages.create({
    model: getGeneratorModel(),
    max_tokens: 8192,
    temperature: 0,
    messages: [{ role: 'user', content: prompt }],
  }, {
    signal: AbortSignal.timeout(GENERATOR_TIMEOUT),
  })

  const textBlock = response.content.find(b => b.type === 'text')
  if (!textBlock || textBlock.type !== 'text') {
    throw new Error('No text response from API')
  }

  // Audit the generated code
  const audit = auditGeneratedCode(textBlock.text)
  if (!audit.safe) {
    const warningMessages = audit.warnings.map(w =>
      `  Line ${w.line}: ${w.message} (${w.pattern})`
    ).join('\n')
    throw new Error(
      `Generated code contains dangerous patterns:\n${warningMessages}\n\nGeneration aborted. Review the knowledge content and try again.`
    )
  }

  const slug = slugify(knowledge.title)
  const mcpDir = process.env['MCP_OUTPUT_DIR'] ?? '.claude/mcp'
  const ext = language === 'typescript' ? 'ts' : 'py'
  const filePath = path.join(mcpDir, `${slug}.${ext}`)

  fs.mkdirSync(mcpDir, { recursive: true })
  fs.writeFileSync(filePath, textBlock.text)

  // Mark as promoted
  promoteKnowledge(knowledgeId)

  // Generate registration snippet (NOT auto-applied)
  const registrationSnippet = JSON.stringify({
    [slug]: {
      command: 'node',
      args: [filePath],
    },
  }, null, 2)

  return { filePath, code: textBlock.text, registrationSnippet }
}

/**
 * Propose CLAUDE.md additions from rule-type knowledge.
 */
export function proposeClaudeMd(
  project: string,
  sessionIds?: string[]
): { additions: string[]; knowledgeIds: number[] } {
  const db = getDb()

  let query = `
    SELECT * FROM knowledge
    WHERE category = 'rule'
      AND promoted = FALSE
      AND confidence_score >= 0.5
      AND (project = ? OR project IS NULL)
  `
  const params: unknown[] = [project]

  if (sessionIds && sessionIds.length > 0) {
    const placeholders = sessionIds.map(() => '?').join(',')
    query += ` AND session_id IN (${placeholders})`
    params.push(...sessionIds)
  }

  query += ' ORDER BY hit_count DESC LIMIT 10'

  const rows = db.prepare(query).all(...params) as KnowledgeRow[]

  const additions: string[] = []
  const knowledgeIds: number[] = []

  for (const row of rows) {
    additions.push(`\n## ${row.title}\n\n${row.content}`)
    knowledgeIds.push(row.id)
  }

  return { additions, knowledgeIds }
}
