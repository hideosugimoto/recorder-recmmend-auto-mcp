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
 * e.g., "Docker起動手順" → "docker--a3f9c1"
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

const SKILL_PROMPT = `You are generating a SKILL.md file for Claude Code. The skill should be a concise, actionable reference that Claude can use in future sessions.

Generate a SKILL.md with the following structure:
1. Title (# heading)
2. When to use this skill (brief trigger conditions)
3. Step-by-step procedure
4. Common pitfalls or notes
5. Example usage (if applicable)

Keep it concise and actionable. Use markdown formatting.
Write in the same language as the input content.

Knowledge to convert into a SKILL.md:
Title: {title}
Category: {category}
Content: {content}
Tags: {tags}

Generate ONLY the SKILL.md content, no wrapping or explanation.`

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
 * Generate a SKILL.md file from a knowledge item.
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
  const prompt = SKILL_PROMPT
    .replace('{title}', knowledge.title)
    .replace('{category}', knowledge.category)
    .replace('{content}', knowledge.content)
    .replace('{tags}', knowledge.tags)

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

  const slug = slugify(knowledge.title)
  const skillsDir = outputPath ?? process.env['SKILLS_OUTPUT_DIR'] ?? '.claude/skills'
  const skillDir = path.join(skillsDir, slug)
  const filePath = path.join(skillDir, 'SKILL.md')

  fs.mkdirSync(skillDir, { recursive: true })
  fs.writeFileSync(filePath, textBlock.text)

  // Mark as promoted
  promoteKnowledge(knowledgeId)

  return { filePath, content: textBlock.text }
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
  const prompt = SKILL_PROMPT
    .replace('{title}', knowledge.title)
    .replace('{category}', knowledge.category)
    .replace('{content}', knowledge.content)
    .replace('{tags}', knowledge.tags)

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

  const slug = slugify(knowledge.title)
  const skillsDir = outputPath ?? process.env['SKILLS_OUTPUT_DIR'] ?? '.claude/skills'
  const skillDir = path.join(skillsDir, slug)
  const filePath = path.join(skillDir, 'SKILL.md')

  fs.mkdirSync(skillDir, { recursive: true })
  fs.writeFileSync(filePath, textBlock.text)

  // Ensure promoted
  promoteKnowledge(knowledgeId)

  return { filePath, content: textBlock.text }
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
