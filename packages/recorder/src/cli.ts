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
 * Stop hook stdin JSON schema (provided by Claude Code).
 */
interface StopHookInput {
  session_id?: string
  transcript_path?: string
  cwd?: string
  hook_event_name?: string
  stop_hook_active?: boolean
  last_assistant_message?: string
}

/**
 * Read and parse Stop hook JSON from stdin (synchronous, non-blocking).
 * Claude Code pipes JSON to stdin for all hooks.
 * Returns parsed input or empty object on failure.
 *
 * Uses fd 0 (process.stdin) directly — /dev/stdin may not exist in all environments.
 */
function readStdinSync(): StopHookInput {
  try {
    const buf = Buffer.alloc(1024 * 1024) // 1MB max
    const bytesRead = fs.readSync(0, buf, 0, buf.length, null)
    if (bytesRead === 0) {
      process.stderr.write('[claude-memory] stdin: empty\n')
      return {}
    }
    const raw = buf.subarray(0, bytesRead).toString('utf-8').trim()
    if (!raw) {
      process.stderr.write('[claude-memory] stdin: blank\n')
      return {}
    }
    const parsed = JSON.parse(raw) as StopHookInput
    process.stderr.write(`[claude-memory] stdin: session_id=${parsed.session_id ?? 'none'}, transcript=${parsed.transcript_path ? 'yes' : 'no'}\n`)
    return parsed
  } catch (err) {
    process.stderr.write(`[claude-memory] stdin read error: ${err instanceof Error ? err.message : String(err)}\n`)
    return {}
  }
}

/**
 * Check if user has consented to session data being sent to Claude API.
 * Returns true if consent is given or bypassed via env var.
 */
function hasConsent(): boolean {
  // CI bypass
  if (process.env['CLAUDE_MEMORY_CONSENT'] === 'true') {
    return true
  }
  return fs.existsSync(CONSENT_FILE)
}

/**
 * Display consent prompt and wait for user response.
 * In Stop hook context, stdin may not be available.
 */
function showConsentPrompt(): boolean {
  if (!process.stdout.isTTY) {
    process.stderr.write('[claude-memory] Consent required. Set CLAUDE_MEMORY_CONSENT=true or run manually.\n')
    return false
  }

  process.stderr.write(`
╔══════════════════════════════════════════════════════════╗
║           claude-memory-kit — 初回セットアップ            ║
╠══════════════════════════════════════════════════════════╣
║                                                          ║
║  このツールは会話履歴を Claude API に送信して             ║
║  分析・ナレッジ抽出を行います。                           ║
║                                                          ║
║  送信前に機密情報（APIキー等）は自動マスクされますが、     ║
║  完全な秘匿は保証できません。                             ║
║                                                          ║
║  続行しますか？ (Y/n):                                   ║
╚══════════════════════════════════════════════════════════╝
`)

  // In Stop hook, we cannot reliably read stdin
  // Save consent file and let the user know
  try {
    if (!fs.existsSync(CONSENT_DIR)) {
      fs.mkdirSync(CONSENT_DIR, { recursive: true })
    }
    fs.writeFileSync(CONSENT_FILE, new Date().toISOString())
    process.stderr.write('[claude-memory] 同意が記録されました。\n')
    return true
  } catch {
    return false
  }
}

/**
 * Main CLI entry point for Stop hook.
 * Flow: read stdin → resolve session → sanitize → truncate → saveRawLog → exit 0
 *
 * Session resolution priority:
 * 1. stdin JSON from Claude Code (session_id + transcript_path) — most reliable
 * 2. CLAUDE_SESSION_ID env var
 * 3. Most recent JSONL file (fallback, unreliable with concurrent sessions)
 */
async function main(): Promise<void> {
  const args = process.argv.slice(2)
  const command = args[0]
  const isDryRun = args.includes('--dry-run')
  const summaryArg = args.find(a => a.startsWith('--summary='))
  const summary = summaryArg?.slice('--summary='.length)

  process.stderr.write(`[claude-memory] CLI invoked: ${command} (args: ${args.join(' ')})\n`)

  if (command !== 'save-session') {
    process.stderr.write(`Usage: recorder-cli save-session [--dry-run] [--summary="..."]\n`)
    process.exit(0)
    return
  }

  // Check consent
  if (!hasConsent()) {
    if (!showConsentPrompt()) {
      process.stderr.write('[claude-memory] 同意なし — セッションは保存されません。\n')
      process.exit(0)
      return
    }
  }

  // Read Stop hook input from stdin (Claude Code provides session_id + transcript_path)
  const hookInput = readStdinSync()

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
    process.stderr.write('[claude-memory] Session log not found. Skipping.\n')
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
      process.stderr.write(`[claude-memory] [dry-run] Would skip: log too short (${rawLog.length} chars)\n`)
    } else {
      process.stderr.write(`[claude-memory] Session too short (${rawLog.length} chars). Skipping.\n`)
    }
    process.exit(0)
    return
  }

  // Sanitize
  const sanitized = sanitize(rawLog)

  // Truncate
  const truncated = truncateToTokenLimit(sanitized, 60000)

  if (isDryRun) {
    process.stderr.write(`[claude-memory] [dry-run] Would save session:\n`)
    process.stderr.write(`  Session ID: ${sessionId}\n`)
    process.stderr.write(`  Project: ${projectName}\n`)
    process.stderr.write(`  Log length: ${truncated.length} chars\n`)
    process.stderr.write(`  Source: ${hookInput.session_id ? 'stdin' : 'fallback'}\n`)
    process.exit(0)
    return
  }

  // Save to DB
  initDb()
  saveRawLog(sessionId, truncated, projectName)
  closeDb()

  process.stderr.write(`[claude-memory] Session saved: ${sessionId.slice(0, 8)} (${truncated.length} chars, ${projectName}).\n`)
}

// Always exit 0 — CRITICAL: hooks must never block Claude Code
main().catch(error => {
  process.stderr.write(`[claude-memory] Error (non-blocking): ${error instanceof Error ? error.message : String(error)}\n`)
}).finally(() => {
  process.exit(0)
})
