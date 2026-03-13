#!/usr/bin/env node
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import * as crypto from 'node:crypto'
import {
  initDb,
  closeDb,
  saveAnalysis,
  cleanupAfterAnalysis,
  runRetentionCleanup,
  checkDbSize,
  resolveProjectName,
  isOnline,
  getMonthlyCost,
  shouldSkipAnalysis,
  analyzeWithRetry,
  calculateCost,
} from '@claude-memory/shared'
import {
  getPendingSessions,
  acquireAnalysisLock,
  markAnalysisFailed,
  markAnalysisSkipped,
  resetFailedToPending,
  getKnowledgeCount,
  getFailedCount,
  skipExpiredPending,
  getPromotedKnowledge,
  demoteKnowledge,
} from './db.js'
import { detectCandidates, formatProposals } from './detector.js'

const LOCK_DIR = path.join(os.tmpdir(), 'claude-memory-locks')
const MAX_PENDING_PER_RUN = 3
const STARTUP_TIMEOUT = 10000

/**
 * Sync promoted knowledge with filesystem.
 * FS is Ground Truth: promoted=TRUE + file missing → promoted=FALSE
 */
function syncPromotedFromDisk(): void {
  const skillsDir = process.env['SKILLS_OUTPUT_DIR'] ?? '.claude/skills'
  const mcpDir = process.env['MCP_OUTPUT_DIR'] ?? '.claude/mcp'
  const promoted = getPromotedKnowledge()

  for (const item of promoted) {
    const slug = slugifyForCheck(item.title)
    const skillPath = path.join(skillsDir, slug, 'SKILL.md')
    const mcpPathTs = path.join(mcpDir, `${slug}.ts`)
    const mcpPathPy = path.join(mcpDir, `${slug}.py`)

    const fileExists = fs.existsSync(skillPath) || fs.existsSync(mcpPathTs) || fs.existsSync(mcpPathPy)

    if (!fileExists) {
      demoteKnowledge(item.id)
      process.stderr.write(`[architect] Demoted knowledge #${item.id} "${item.title}" (file not found)\n`)
    }
  }
}

function slugifyForCheck(title: string): string {
  const hash = crypto.createHash('sha256').update(title).digest('hex').slice(0, 6)
  const slug = title.toLowerCase().replace(/[^\w\s-]/g, '').replace(/[\s_]+/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '')
  return slug ? `${slug}-${hash}` : hash
}

/**
 * Acquire an O_EXCL lock file to prevent multiple startup checks in the same session.
 */
function acquireLock(sessionId: string): boolean {
  if (!fs.existsSync(LOCK_DIR)) {
    fs.mkdirSync(LOCK_DIR, { recursive: true })
  }

  const lockPath = path.join(LOCK_DIR, `architect-${sessionId}.lock`)
  try {
    const fd = fs.openSync(lockPath, fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY)
    fs.writeSync(fd, process.pid.toString())
    fs.closeSync(fd)
    return true
  } catch {
    return false // Lock already held
  }
}

/**
 * Main startup check flow with AbortController timeout.
 */
async function runStartupWithTimeout(timeoutMs = STARTUP_TIMEOUT): Promise<void> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)

  try {
    await runStartupCheck(controller.signal)
  } finally {
    clearTimeout(timer)
  }
}

async function runStartupCheck(signal: AbortSignal): Promise<void> {
  const project = resolveProjectName()
  const isDryRun = process.argv.includes('--dry-run')

  // DB size warning
  const { warning, sizeBytes } = checkDbSize()
  if (warning) {
    process.stderr.write(`[architect] WARNING: DB size ${(sizeBytes / 1024 / 1024).toFixed(1)}MB exceeds 100MB\n`)
  }

  // Phase 0: Sync promoted from disk
  if (!isDryRun) {
    syncPromotedFromDisk()
  }

  // Reset failed → pending
  const resetCount = isDryRun ? 0 : resetFailedToPending(project)
  if (resetCount > 0) {
    process.stderr.write(`[architect] Reset ${resetCount} failed session(s) to pending\n`)
  }

  // Skip expired pending sessions
  if (!isDryRun) {
    const pendingTtlDays = parseInt(process.env['PENDING_TTL_DAYS'] ?? '7', 10)
    skipExpiredPending(pendingTtlDays)
  }

  // Show failed count
  const failedCount = getFailedCount(project)
  if (failedCount > 0) {
    process.stderr.write(`[architect] ${failedCount} previously failed session(s)\n`)
  }

  // Phase 1: Analyze pending sessions (max 3)
  const pending = getPendingSessions(project, MAX_PENDING_PER_RUN)

  if (pending.length > 0) {
    if (signal.aborted) return

    // Check API key
    const apiKey = process.env['ANTHROPIC_API_KEY']
    if (!apiKey) {
      process.stderr.write('[architect] ANTHROPIC_API_KEY not set. Pending sessions will be analyzed later.\n')
      return
    }

    // Check monthly cost limit
    const maxCost = parseFloat(process.env['MAX_MONTHLY_COST_USD'] ?? '5.0')
    const currentCost = getMonthlyCost(project)
    if (currentCost >= maxCost) {
      process.stderr.write(`[architect] Monthly cost limit reached ($${currentCost.toFixed(2)}/$${maxCost.toFixed(2)}). Skipping analysis.\n`)
      return
    }

    // Check network
    const online = await isOnline()
    if (!online) {
      process.stderr.write('[architect] Offline. Analysis deferred.\n')
      return
    }

    for (const session of pending) {
      if (signal.aborted) return

      // Check if log should be skipped
      if (!session.raw_log || shouldSkipAnalysis(session.raw_log)) {
        if (!isDryRun) markAnalysisSkipped(session.id)
        continue
      }

      // Optimistic lock
      if (isDryRun) {
        process.stderr.write(`[architect] [dry-run] Would analyze session ${session.id}\n`)
        continue
      }

      if (!acquireAnalysisLock(session.id)) {
        continue // Another process got it
      }

      try {
        const { result, inputTokens, outputTokens } = await analyzeWithRetry(session.raw_log, apiKey)
        const costUsd = calculateCost(inputTokens, outputTokens)

        saveAnalysis(session.id, result, project, { inputTokens, outputTokens, costUsd })
        cleanupAfterAnalysis(session.id)

        process.stderr.write(`[architect] Analyzed session ${session.id} ($${costUsd.toFixed(4)})\n`)
      } catch (error) {
        if (error instanceof Error && 'status' in error) {
          const status = (error as { status: number }).status
          if (status >= 400 && status < 500) {
            markAnalysisSkipped(session.id)
            process.stderr.write(`[architect] Session ${session.id} skipped (${status})\n`)
            continue
          }
        }
        markAnalysisFailed(session.id)
        process.stderr.write(`[architect] Session ${session.id} failed: ${error instanceof Error ? error.message : String(error)}\n`)
      }
    }
  }

  // Phase 2: Detect candidates
  if (signal.aborted) return

  const knowledgeCount = getKnowledgeCount(project)
  if (knowledgeCount === 0) {
    // Coldstart: show welcome message once
    process.stderr.write('[architect] claude-memory-kit: No knowledge yet. Sessions will be analyzed automatically.\n')
    return
  }

  const threshold = parseInt(process.env['CANDIDATE_THRESHOLD'] ?? '3', 10)
  const candidates = detectCandidates(threshold, project)

  if (candidates.length > 0) {
    const proposals = formatProposals(candidates)
    process.stderr.write(proposals + '\n')
  }

  // Phase 3: Cleanup (async, fire-and-forget)
  if (!isDryRun) {
    try {
      const retentionDays = parseInt(process.env['RETENTION_DAYS'] ?? '90', 10)
      runRetentionCleanup(retentionDays)
    } catch {
      // Cleanup failure is non-critical
    }
  }
}

/**
 * Main entry point.
 */
async function main(): Promise<void> {
  const args = process.argv.slice(2)
  const command = args[0]

  if (command !== 'startup-check') {
    process.stderr.write('Usage: architect-cli startup-check [--dry-run]\n')
    process.exit(0)
    return
  }

  initDb()

  // O_EXCL lock: prevent multiple startup checks per session
  const sessionId = process.env['CLAUDE_SESSION_ID'] ?? 'default'
  if (!acquireLock(sessionId)) {
    closeDb()
    process.exit(0)
    return
  }

  await runStartupWithTimeout()
  closeDb()
}

// Always exit 0 — CRITICAL: hooks must never block Claude Code
main().catch(error => {
  process.stderr.write(`[architect] Error (non-blocking): ${error instanceof Error ? error.message : String(error)}\n`)
}).finally(() => {
  process.exit(0)
})
