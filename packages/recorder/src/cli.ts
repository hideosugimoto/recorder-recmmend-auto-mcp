#!/usr/bin/env node
import * as path from 'node:path'
import * as os from 'node:os'
import * as fs from 'node:fs'
import {
  initDb,
  closeDb,
  saveRawLog,
  resolveSessionId,
  resolveSessionLog,
  resolveProjectName,
  extractConversationFromJsonl,
  extractProjectNameFromJsonl,
  truncateToTokenLimit,
} from '@claude-memory/shared'
import { sanitize, shouldSkipAnalysis } from './analyzer.js'

const CONSENT_DIR = path.join(os.homedir(), '.claude-memory')
const CONSENT_FILE = path.join(CONSENT_DIR, 'consented')

/**
 * Hook stdin JSON schema (provided by Claude Code for Stop/SessionEnd hooks).
 */
interface HookInput {
  session_id?: string
  transcript_path?: string
  cwd?: string
  hook_event_name?: string
  stop_hook_active?: boolean
  last_assistant_message?: string
}

/**
 * Read and parse hook JSON from stdin (synchronous).
 * Claude Code pipes JSON to stdin for all hooks.
 * Uses fd 0 (process.stdin) directly.
 */
function readStdinSync(): HookInput {
  try {
    const buf = Buffer.alloc(1024 * 1024) // 1MB max
    const bytesRead = fs.readSync(0, buf, 0, buf.length, null)
    if (bytesRead === 0) return {}
    const raw = buf.subarray(0, bytesRead).toString('utf-8').trim()
    if (!raw) return {}
    return JSON.parse(raw) as HookInput
  } catch {
    return {}
  }
}

/**
 * Check if user has consented to session data being sent to Claude API.
 */
function hasConsent(): boolean {
  if (process.env['CLAUDE_MEMORY_CONSENT'] === 'true') {
    return true
  }
  return fs.existsSync(CONSENT_FILE)
}

/**
 * Auto-consent in non-TTY hook context (consent file creation).
 */
function ensureConsent(): boolean {
  if (hasConsent()) return true

  try {
    if (!fs.existsSync(CONSENT_DIR)) {
      fs.mkdirSync(CONSENT_DIR, { recursive: true })
    }
    fs.writeFileSync(CONSENT_FILE, new Date().toISOString())
    return true
  } catch {
    return false
  }
}

/**
 * Main CLI entry point for SessionEnd / Stop hook.
 * Flow: read stdin → resolve session → sanitize → truncate → saveRawLog → exit 0
 *
 * Session resolution priority:
 * 1. stdin JSON from Claude Code (session_id + transcript_path) — most reliable
 * 2. CLAUDE_SESSION_ID env var
 * 3. Most recent JSONL file (fallback)
 */
async function main(): Promise<void> {
  const args = process.argv.slice(2)
  const command = args[0]
  const isDryRun = args.includes('--dry-run')
  const summaryArg = args.find(a => a.startsWith('--summary='))
  const summary = summaryArg?.slice('--summary='.length)

  if (command !== 'save-session') {
    process.stderr.write(`Usage: recorder-cli save-session [--dry-run] [--summary="..."]\n`)
    process.exit(0)
    return
  }

  // Read hook input from stdin
  const hookInput = readStdinSync()

  // Skip if Stop hook is in active loop (prevent infinite recursion)
  if (hookInput.stop_hook_active) {
    process.exit(0)
    return
  }

  // Check consent
  if (!ensureConsent()) {
    process.exit(0)
    return
  }

  // Resolve session ID: stdin > env > file-based fallback
  const sessionId = hookInput.session_id || resolveSessionId()

  // Resolve session log: transcript_path from stdin > file-based fallback
  let rawLog: string | null = null

  if (hookInput.transcript_path) {
    try {
      if (fs.existsSync(hookInput.transcript_path)) {
        const content = fs.readFileSync(hookInput.transcript_path, 'utf-8')
        rawLog = extractConversationFromJsonl(content)
      }
    } catch {
      // Fall through to resolveSessionLog
    }
  }

  if (!rawLog) {
    rawLog = resolveSessionLog(sessionId, summary)
  }

  if (!rawLog) {
    process.exit(0)
    return
  }

  // Resolve project name: stdin cwd > JSONL metadata > process.cwd()
  let projectName: string
  if (hookInput.cwd) {
    projectName = path.basename(hookInput.cwd)
  } else if (hookInput.transcript_path) {
    try {
      const content = fs.readFileSync(hookInput.transcript_path, 'utf-8')
      projectName = extractProjectNameFromJsonl(content)
    } catch {
      projectName = resolveProjectName()
    }
  } else {
    projectName = resolveProjectName()
  }

  // Skip short sessions
  if (shouldSkipAnalysis(rawLog)) {
    if (isDryRun) {
      process.stderr.write(`[claude-memory] [dry-run] skip: too short (${rawLog.length} chars)\n`)
    }
    process.exit(0)
    return
  }

  // Sanitize + Truncate
  const sanitized = sanitize(rawLog)
  const truncated = truncateToTokenLimit(sanitized, 60000)

  if (isDryRun) {
    process.stderr.write(`[claude-memory] [dry-run] save: ${sessionId.slice(0, 8)} (${truncated.length} chars, ${projectName})\n`)
    process.exit(0)
    return
  }

  // Save to DB
  initDb()
  saveRawLog(sessionId, truncated, projectName)
  closeDb()
}

// Always exit 0 — CRITICAL: hooks must never block Claude Code
main().catch(() => {}).finally(() => {
  process.exit(0)
})
