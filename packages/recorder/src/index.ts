#!/usr/bin/env node
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { z } from 'zod'
import { initDb, closeDb, saveRawLog, resolveSessionId, resolveSessionLog, resolveProjectName, truncateToTokenLimit } from '@claude-memory/shared'
import { sanitize, shouldSkipAnalysis } from './analyzer.js'
import { upsertKnowledge, searchKnowledge, reviewKnowledge, listSessions, showCost } from './db.js'

const server = new McpServer({
  name: 'claude-memory-recorder',
  version: '1.0.0',
})

// Initialize DB on startup
initDb()

// === Auto-execution tool (called from Stop hook) ===
server.tool(
  'save_session',
  'Save the current session log to the database for later analysis. Called automatically by Stop hook.',
  { session_id: z.string().describe('The session ID to save') },
  async ({ session_id }) => {
    try {
      const projectName = resolveProjectName()
      const rawLog = resolveSessionLog(session_id)

      if (!rawLog) {
        return { content: [{ type: 'text' as const, text: 'Session log not found.' }] }
      }

      if (shouldSkipAnalysis(rawLog)) {
        return { content: [{ type: 'text' as const, text: `Session too short (${rawLog.length} chars). Skipped.` }] }
      }

      const sanitized = sanitize(rawLog)
      const truncated = truncateToTokenLimit(sanitized, 60000)
      saveRawLog(session_id, truncated, projectName)

      return {
        content: [{ type: 'text' as const, text: `Session saved (${truncated.length} chars, pending analysis).` }],
      }
    } catch (error) {
      return {
        content: [{ type: 'text' as const, text: `Error saving session: ${error instanceof Error ? error.message : String(error)}` }],
      }
    }
  }
)

// === User-facing tools ===

server.tool(
  'save_knowledge',
  'Manually save a piece of knowledge to the database.',
  {
    content: z.string().describe('The knowledge content to save'),
    category: z.enum(['skills', 'mcp', 'debug', 'workflow', 'rule']).describe('Knowledge category'),
    tags: z.array(z.string()).describe('Tags for categorization'),
    title: z.string().optional().describe('Short title (auto-generated if omitted)'),
  },
  async ({ content, category, tags, title }) => {
    try {
      const projectName = resolveProjectName()
      const sessionId = resolveSessionId()
      const knowledgeTitle = title ?? content.slice(0, 20)

      const result = upsertKnowledge(sessionId, projectName, {
        category,
        title: knowledgeTitle,
        content,
        tags,
      })

      return {
        content: [{ type: 'text' as const, text: `Knowledge ${result.action}d (id: ${result.id}).` }],
      }
    } catch (error) {
      return {
        content: [{ type: 'text' as const, text: `Error: ${error instanceof Error ? error.message : String(error)}` }],
      }
    }
  }
)

server.tool(
  'list_sessions',
  'List recent recorded sessions.',
  { limit: z.number().optional().default(10).describe('Number of sessions to return') },
  async ({ limit }) => {
    try {
      const sessions = listSessions(limit)
      return {
        content: [{ type: 'text' as const, text: JSON.stringify(sessions, null, 2) }],
      }
    } catch (error) {
      return {
        content: [{ type: 'text' as const, text: `Error: ${error instanceof Error ? error.message : String(error)}` }],
      }
    }
  }
)

server.tool(
  'search_knowledge',
  'Search the knowledge base. Each search increments reference_count for returned results.',
  {
    query: z.string().describe('Search query'),
    project: z.string().optional().describe('Filter by project name'),
  },
  async ({ query, project }) => {
    try {
      const results = searchKnowledge(query, project)
      if (results.length === 0) {
        return { content: [{ type: 'text' as const, text: 'No knowledge found.' }] }
      }
      return {
        content: [{ type: 'text' as const, text: JSON.stringify(results, null, 2) }],
      }
    } catch (error) {
      return {
        content: [{ type: 'text' as const, text: `Error: ${error instanceof Error ? error.message : String(error)}` }],
      }
    }
  }
)

server.tool(
  'review_knowledge',
  'Review knowledge items. If id is provided, shows that item. Otherwise shows low-confidence items.',
  { id: z.number().optional().describe('Knowledge ID to review') },
  async ({ id }) => {
    try {
      const items = reviewKnowledge(id)
      if (items.length === 0) {
        return { content: [{ type: 'text' as const, text: 'No items to review.' }] }
      }
      return {
        content: [{ type: 'text' as const, text: JSON.stringify(items, null, 2) }],
      }
    } catch (error) {
      return {
        content: [{ type: 'text' as const, text: `Error: ${error instanceof Error ? error.message : String(error)}` }],
      }
    }
  }
)

server.tool(
  'show_cost',
  'Show API cost summary.',
  {
    period: z.enum(['today', 'week', 'month']).optional().default('month').describe('Time period'),
    project: z.string().optional().describe('Filter by project'),
  },
  async ({ period, project }) => {
    try {
      const cost = showCost(period, project)
      return {
        content: [{ type: 'text' as const, text: JSON.stringify(cost, null, 2) }],
      }
    } catch (error) {
      return {
        content: [{ type: 'text' as const, text: `Error: ${error instanceof Error ? error.message : String(error)}` }],
      }
    }
  }
)

// Start server
async function main() {
  const transport = new StdioServerTransport()
  await server.connect(transport)
}

main().catch(error => {
  process.stderr.write(`[recorder] Fatal: ${error instanceof Error ? error.message : String(error)}\n`)
  process.exit(1)
})
