#!/usr/bin/env node
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { z } from 'zod'
import {
  initDb,
  saveAnalysis,
  cleanupAfterAnalysis,
  runRetentionCleanup,
  resolveProjectName,
  isOnline,
  getMonthlyCost,
} from '@claude-memory/shared'
import {
  getPendingSessions,
  acquireAnalysisLock,
  markAnalysisFailed,
  markAnalysisSkipped,
  resetFailedToPending,
  invalidateKnowledge,
  confirmKnowledge,
  clearPendingSessions,
  listStaleKnowledge,
  getMonthlyCostForProject,
} from './db.js'
import { detectCandidates, formatProposals } from './detector.js'
import { generateSkill, forceRegenerateSkill, generateMcp, proposeClaudeMd } from './generator.js'

const server = new McpServer({
  name: 'claude-memory-architect',
  version: '1.0.0',
})

// Initialize DB on startup
initDb()

// === Auto-execution tool (called from PreToolUse hook) ===
server.tool(
  'analyze',
  'Analyze pending sessions and detect Skills/MCP candidates. Called automatically by PreToolUse hook.',
  { threshold: z.number().optional().default(3).describe('Minimum hit_count for candidate detection') },
  async ({ threshold }) => {
    try {
      const project = resolveProjectName()

      // Reset failed → pending
      resetFailedToPending(project)

      // Check pending sessions
      const pending = getPendingSessions(project, 3)

      const results: string[] = []

      if (pending.length > 0) {
        const apiKey = process.env['ANTHROPIC_API_KEY']
        if (!apiKey) {
          results.push('ANTHROPIC_API_KEY not set. Pending sessions deferred.')
        } else {
          const online = await isOnline()
          if (!online) {
            results.push('Offline. Analysis deferred.')
          } else {
            const maxCost = parseFloat(process.env['MAX_MONTHLY_COST_USD'] ?? '5.0')
            const currentCost = getMonthlyCost(project)
            if (currentCost >= maxCost) {
              results.push(`Monthly cost limit reached ($${currentCost.toFixed(2)}/$${maxCost.toFixed(2)}).`)
            } else {
              // Dynamic import to avoid circular dependency
              const { analyzeWithRetry, shouldSkipAnalysis, calculateCost } = await import('@claude-memory/shared')

              for (const session of pending) {
                if (!session.raw_log || shouldSkipAnalysis(session.raw_log)) {
                  markAnalysisSkipped(session.id)
                  results.push(`Session ${session.id}: skipped (too short)`)
                  continue
                }

                if (!acquireAnalysisLock(session.id)) {
                  results.push(`Session ${session.id}: locked by another process`)
                  continue
                }

                try {
                  const { result, inputTokens, outputTokens } = await analyzeWithRetry(session.raw_log, apiKey)
                  const costUsd = calculateCost(inputTokens, outputTokens)
                  saveAnalysis(session.id, result, project, { inputTokens, outputTokens, costUsd })
                  cleanupAfterAnalysis(session.id)
                  results.push(`Session ${session.id}: analyzed ($${costUsd.toFixed(4)})`)
                } catch (error) {
                  markAnalysisFailed(session.id)
                  results.push(`Session ${session.id}: failed — ${error instanceof Error ? error.message : String(error)}`)
                }
              }
            }
          }
        }
      } else {
        results.push('No pending sessions.')
      }

      // Detect candidates
      const candidates = detectCandidates(threshold, project)
      if (candidates.length > 0) {
        results.push(formatProposals(candidates))
      }

      // Cleanup (fire-and-forget)
      try { runRetentionCleanup() } catch { /* non-critical */ }

      return {
        content: [{ type: 'text' as const, text: results.join('\n') }],
      }
    } catch (error) {
      return {
        content: [{ type: 'text' as const, text: `Error: ${error instanceof Error ? error.message : String(error)}` }],
      }
    }
  }
)

// === User-facing tools ===

server.tool(
  'generate_skill',
  'Generate a SKILL.md file from a knowledge item.',
  {
    knowledge_id: z.number().describe('Knowledge item ID'),
    output_path: z.string().optional().describe('Custom output directory'),
  },
  async ({ knowledge_id, output_path }) => {
    try {
      const { filePath, content } = await generateSkill(knowledge_id, output_path)
      return {
        content: [{ type: 'text' as const, text: `SKILL.md generated at ${filePath}\n\n${content}` }],
      }
    } catch (error) {
      return {
        content: [{ type: 'text' as const, text: `Error: ${error instanceof Error ? error.message : String(error)}` }],
      }
    }
  }
)

server.tool(
  'generate_mcp',
  'Generate an MCP server from a knowledge item. Does NOT auto-register in settings.json.',
  {
    knowledge_id: z.number().describe('Knowledge item ID'),
    language: z.enum(['typescript', 'python']).optional().default('typescript').describe('Output language'),
  },
  async ({ knowledge_id, language }) => {
    try {
      const { filePath, registrationSnippet } = await generateMcp(knowledge_id, language)
      return {
        content: [{ type: 'text' as const, text: `MCP server generated at ${filePath}\n\nTo register, add to .claude/settings.json mcpServers:\n${registrationSnippet}` }],
      }
    } catch (error) {
      return {
        content: [{ type: 'text' as const, text: `Error: ${error instanceof Error ? error.message : String(error)}` }],
      }
    }
  }
)

server.tool(
  'propose_claude_md',
  'Propose additions to CLAUDE.md from rule-type knowledge.',
  { session_ids: z.array(z.string()).optional().describe('Filter by session IDs') },
  async ({ session_ids }) => {
    try {
      const project = resolveProjectName()
      const { additions, knowledgeIds } = proposeClaudeMd(project, session_ids)

      if (additions.length === 0) {
        return { content: [{ type: 'text' as const, text: 'No rule knowledge to propose.' }] }
      }

      return {
        content: [{ type: 'text' as const, text: `Proposed CLAUDE.md additions (knowledge IDs: ${knowledgeIds.join(', ')}):\n${additions.join('\n')}` }],
      }
    } catch (error) {
      return {
        content: [{ type: 'text' as const, text: `Error: ${error instanceof Error ? error.message : String(error)}` }],
      }
    }
  }
)

server.tool(
  'invalidate_knowledge',
  'Invalidate a knowledge item (set confidence to 0.0).',
  {
    id: z.number().describe('Knowledge ID'),
    reason: z.string().describe('Reason for invalidation'),
  },
  async ({ id, reason }) => {
    try {
      invalidateKnowledge(id, reason)
      return { content: [{ type: 'text' as const, text: `Knowledge #${id} invalidated: ${reason}` }] }
    } catch (error) {
      return {
        content: [{ type: 'text' as const, text: `Error: ${error instanceof Error ? error.message : String(error)}` }],
      }
    }
  }
)

server.tool(
  'confirm_knowledge',
  'Confirm a knowledge item (reset confidence to 1.0).',
  { id: z.number().describe('Knowledge ID') },
  async ({ id }) => {
    try {
      confirmKnowledge(id)
      return { content: [{ type: 'text' as const, text: `Knowledge #${id} confirmed (confidence=1.0).` }] }
    } catch (error) {
      return {
        content: [{ type: 'text' as const, text: `Error: ${error instanceof Error ? error.message : String(error)}` }],
      }
    }
  }
)

server.tool(
  'force_regenerate_skill',
  'Force regenerate a SKILL.md for an already-promoted knowledge item.',
  { knowledge_id: z.number().describe('Knowledge item ID') },
  async ({ knowledge_id }) => {
    try {
      const { filePath, content } = await forceRegenerateSkill(knowledge_id)
      return {
        content: [{ type: 'text' as const, text: `SKILL.md regenerated at ${filePath}\n\n${content}` }],
      }
    } catch (error) {
      return {
        content: [{ type: 'text' as const, text: `Error: ${error instanceof Error ? error.message : String(error)}` }],
      }
    }
  }
)

server.tool(
  'list_stale_knowledge',
  'List knowledge items that may be outdated.',
  { days_unused: z.number().optional().default(90).describe('Days since last reference') },
  async ({ days_unused }) => {
    try {
      const items = listStaleKnowledge(days_unused)
      if (items.length === 0) {
        return { content: [{ type: 'text' as const, text: 'No stale knowledge found.' }] }
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
  'clear_pending_sessions',
  'Clear all pending (unanalyzed) sessions.',
  {},
  async () => {
    try {
      const count = clearPendingSessions()
      return { content: [{ type: 'text' as const, text: `${count} pending session(s) cleared.` }] }
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
      const cost = getMonthlyCostForProject(project)
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
  process.stderr.write(`[architect] Fatal: ${error instanceof Error ? error.message : String(error)}\n`)
  process.exit(1)
})
