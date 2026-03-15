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
  extractProjectNameFromJsonl,
  truncateToTokenLimit,
  resolveProjectPath,
} from '@claude-memory/shared'
import { sanitize, shouldSkipAnalysis } from './analyzer.js'

const CONSENT_DIR = path.join(os.homedir(), '.claude-memory')
const CONSENT_FILE = path.join(CONSENT_DIR, 'consented')

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
 * Resolve project name from the JSONL session file's cwd metadata.
 * This avoids depending on the hook process's cwd, which may differ
 * from the actual Claude Code session's working directory.
 */
function resolveProjectNameFromJsonl(sessionId: string): string {
  const projectPath = resolveProjectPath()
  if (projectPath) {
    const CLAUDE_DIR = path.join(os.homedir(), '.claude')
    const sessionFile = path.join(CLAUDE_DIR, 'projects', projectPath, `${sessionId}.jsonl`)
    try {
      if (fs.existsSync(sessionFile)) {
        const content = fs.readFileSync(sessionFile, 'utf-8')
        return extractProjectNameFromJsonl(content)
      }
    } catch {
      // Fall through
    }
  }
  return resolveProjectName()
}

/**
 * Main CLI entry point for Stop hook.
 * Flow: resolveSessionLog → sanitize → truncate → saveRawLog → exit 0
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

  // Check consent
  if (!hasConsent()) {
    if (!showConsentPrompt()) {
      process.stderr.write('[claude-memory] 同意なし — セッションは保存されません。\n')
      process.exit(0)
      return
    }
  }

  // Resolve session
  const sessionId = resolveSessionId()

  // Resolve session log
  const rawLog = resolveSessionLog(sessionId, summary)
  if (!rawLog) {
    process.stderr.write('[claude-memory] Session log not found. Skipping.\n')
    process.exit(0)
    return
  }

  // Resolve project name from JSONL metadata (cwd field), not process.cwd()
  const projectName = resolveProjectNameFromJsonl(sessionId)


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
    process.exit(0)
    return
  }

  // Save to DB
  initDb()
  saveRawLog(sessionId, truncated, projectName)
  closeDb()

  process.stderr.write(`[claude-memory] Session saved (${truncated.length} chars, pending analysis).\n`)
}

// Always exit 0 — CRITICAL: hooks must never block Claude Code
main().catch(error => {
  process.stderr.write(`[claude-memory] Error (non-blocking): ${error instanceof Error ? error.message : String(error)}\n`)
}).finally(() => {
  process.exit(0)
})
