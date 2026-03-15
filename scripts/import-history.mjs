#!/usr/bin/env node
/**
 * Import past Claude Code session history into claude-memory-kit DB.
 *
 * Usage:
 *   npm run import-history                        # all projects
 *   npm run import-history -- --dry-run            # preview only
 *   npm run import-history -- --project aisupport  # specific project
 */
import { readFileSync, readdirSync, existsSync, statSync } from 'node:fs'
import { join, basename } from 'node:path'
import { homedir } from 'node:os'

const CLAUDE_PROJECTS_DIR = join(homedir(), '.claude', 'projects')

// ── Dynamic import of built shared package ──────────────────────
let shared
try {
  shared = await import('../packages/shared/dist/index.js')
} catch {
  console.error('  error: shared package not built. Run "npm run build" first.')
  process.exit(1)
}

const {
  initDb,
  closeDb,
  saveRawLog,
  extractConversationFromJsonl,
  sanitize,
  shouldSkipAnalysis,
  truncateToTokenLimit,
} = shared

// ── CLI args ────────────────────────────────────────────────────
const args = process.argv.slice(2)
const isDryRun = args.includes('--dry-run')
const projectIdx = args.indexOf('--project')
const projectFilter = projectIdx >= 0 ? args[projectIdx + 1] : null

// ── Helpers ─────────────────────────────────────────────────────

/**
 * Extract project name from encoded project path.
 * Claude Code encodes cwd by replacing "/" with "-":
 *   /Users/sugimotohideo/develop/aisupport → -Users-sugimotohideo-develop-aisupport
 *
 * Since "-" is ambiguous (directory separator vs literal hyphen), we strip
 * the known homedir prefix and try to find the real directory on disk.
 * Falls back to the last segment of the encoded path.
 */
function extractProjectName(encodedPath) {
  // Encode homedir the same way Claude Code does
  const homeEncoded = homedir().replace(/\//g, '-')

  if (encodedPath.startsWith(homeEncoded)) {
    // Remainder after homedir prefix, e.g., "-develop-aisupport" or "-develop-recorder-recmmend-auto-mcp"
    const remainder = encodedPath.slice(homeEncoded.length)
    // Try to find the actual directory by checking filesystem
    const segments = remainder.split('-').filter(Boolean)

    // Build path from homedir, greedily matching real directories
    let currentPath = homedir()
    let lastMatchedIdx = -1

    for (let i = 0; i < segments.length; i++) {
      const candidate = join(currentPath, segments[i])
      if (existsSync(candidate) && statSync(candidate).isDirectory()) {
        currentPath = candidate
        lastMatchedIdx = i
      } else {
        // Try joining remaining segments with hyphens (for hyphenated dir names)
        let found = false
        for (let j = segments.length; j > i; j--) {
          const hyphenated = segments.slice(i, j).join('-')
          const hyphenCandidate = join(currentPath, hyphenated)
          if (existsSync(hyphenCandidate) && statSync(hyphenCandidate).isDirectory()) {
            currentPath = hyphenCandidate
            lastMatchedIdx = j - 1
            i = j - 1
            found = true
            break
          }
        }
        if (!found) break
      }
    }

    if (lastMatchedIdx >= 0) {
      return basename(currentPath)
    }
  }

  // Fallback: last segment of encoded path
  const parts = encodedPath.split('-').filter(Boolean)
  return parts[parts.length - 1] || encodedPath
}

/**
 * Discover all session JSONL files under ~/.claude/projects/.
 * Returns array of { sessionId, projectName, filePath }.
 */
function discoverSessions() {
  const sessions = []

  if (!existsSync(CLAUDE_PROJECTS_DIR)) {
    return sessions
  }

  const projectDirs = readdirSync(CLAUDE_PROJECTS_DIR)

  for (const dir of projectDirs) {
    const projectName = extractProjectName(dir)

    // Apply project filter
    if (projectFilter && projectName !== projectFilter) {
      continue
    }

    const projectPath = join(CLAUDE_PROJECTS_DIR, dir)
    let stat
    try {
      stat = statSync(projectPath)
    } catch {
      continue
    }
    if (!stat.isDirectory()) continue

    const files = readdirSync(projectPath).filter(f => f.endsWith('.jsonl'))

    for (const file of files) {
      const sessionId = basename(file, '.jsonl')
      sessions.push({
        sessionId,
        projectName,
        filePath: join(projectPath, file),
      })
    }
  }

  return sessions
}

// ── Main ────────────────────────────────────────────────────────

function main() {
  console.log(`\n  claude-memory-kit: import history`)
  if (isDryRun) console.log('  mode: dry-run')
  if (projectFilter) console.log(`  filter: project=${projectFilter}`)

  const sessions = discoverSessions()
  console.log(`  found: ${sessions.length} session files\n`)

  if (sessions.length === 0) {
    console.log('  no sessions to import.\n')
    return
  }

  if (!isDryRun) {
    initDb()
  }

  let imported = 0
  let skipped = 0
  let errors = 0

  for (const { sessionId, projectName, filePath } of sessions) {
    try {
      const content = readFileSync(filePath, 'utf-8')
      const conversation = extractConversationFromJsonl(content)

      if (!conversation || shouldSkipAnalysis(conversation)) {
        skipped++
        continue
      }

      const sanitized = sanitize(conversation)
      const truncated = truncateToTokenLimit(sanitized, 60000)

      if (isDryRun) {
        console.log(`  [dry-run] ${projectName} / ${sessionId} (${truncated.length} chars)`)
        imported++
        continue
      }

      saveRawLog(sessionId, truncated, projectName)
      imported++
    } catch (err) {
      errors++
      console.error(`  [error] ${projectName} / ${sessionId}: ${err.message}`)
    }
  }

  if (!isDryRun) {
    closeDb()
  }

  console.log(`\n  results:`)
  console.log(`    imported: ${imported}`)
  console.log(`    skipped:  ${skipped} (too short)`)
  if (errors > 0) console.log(`    errors:   ${errors}`)
  console.log(`    total:    ${sessions.length}`)
  console.log()
}

main()
