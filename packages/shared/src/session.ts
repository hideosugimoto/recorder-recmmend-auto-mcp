import * as path from 'node:path'
import * as os from 'node:os'
import * as fs from 'node:fs'
import * as crypto from 'node:crypto'

const CLAUDE_DIR = path.join(os.homedir(), '.claude')

/**
 * Resolve the current session ID using 3-stage fallback:
 * 1. CLAUDE_SESSION_ID environment variable
 * 2. Most recent session JSONL file in the project directory
 * 3. Generate from current timestamp
 */
export function resolveSessionId(): string {
  // Stage 1: Environment variable
  const envSessionId = process.env['CLAUDE_SESSION_ID']
  if (envSessionId) {
    return envSessionId
  }

  // Stage 2: Most recent session file
  const projectPath = resolveProjectPath()
  if (projectPath) {
    const projectDir = path.join(CLAUDE_DIR, 'projects', projectPath)
    try {
      if (fs.existsSync(projectDir)) {
        const files = fs.readdirSync(projectDir)
          .filter(f => f.endsWith('.jsonl'))
          .map(f => ({
            name: f,
            mtime: fs.statSync(path.join(projectDir, f)).mtime.getTime(),
          }))
          .sort((a, b) => b.mtime - a.mtime)

        if (files.length > 0) {
          return files[0].name.replace('.jsonl', '')
        }
      }
    } catch {
      // Fall through to stage 3
    }
  }

  // Stage 3: Generate from timestamp
  return crypto.randomUUID()
}

/**
 * Resolve the session log content using 3-stage fallback:
 * 1. Session JSONL file in ~/.claude/projects/{project-path}/{session_id}.jsonl
 * 2. Telemetry logs in ~/.claude/telemetry/
 * 3. CLI argument --summary
 */
export function resolveSessionLog(sessionId: string, summary?: string): string | null {
  // Stage 1: Session JSONL file
  const projectPath = resolveProjectPath()
  if (projectPath) {
    const sessionFile = path.join(CLAUDE_DIR, 'projects', projectPath, `${sessionId}.jsonl`)
    try {
      if (fs.existsSync(sessionFile)) {
        const content = fs.readFileSync(sessionFile, 'utf-8')
        return extractConversationFromJsonl(content)
      }
    } catch {
      // Fall through to stage 2
    }
  }

  // Stage 2: Telemetry logs
  const telemetryLog = extractFromTelemetry(sessionId)
  if (telemetryLog) {
    return telemetryLog
  }

  // Stage 3: CLI summary
  if (summary) {
    return summary
  }

  return null
}

/**
 * Convert current working directory to Claude's project path format.
 * e.g., /Users/sugimotohideo/develop/project → -Users-sugimotohideo-develop-project
 */
export function resolveProjectPath(): string | null {
  try {
    const cwd = process.cwd()
    return cwd.replace(/\//g, '-')
  } catch {
    return null
  }
}

/**
 * Resolve project name from environment or cwd.
 */
export function resolveProjectName(): string {
  return process.env['CLAUDE_PROJECT_NAME'] ?? path.basename(process.cwd())
}

/**
 * Extract project name from JSONL session content by reading the cwd field.
 * JSONL entries contain {"cwd": "/Users/foo/develop/myproject", ...}
 * Returns path.basename(cwd), e.g., "myproject".
 * Falls back to resolveProjectName() if cwd is not found in JSONL.
 */
export function extractProjectNameFromJsonl(content: string): string {
  const lines = content.split('\n').filter(l => l.trim())

  for (const line of lines) {
    try {
      const entry = JSON.parse(line)
      if (entry.cwd && typeof entry.cwd === 'string') {
        return path.basename(entry.cwd)
      }
    } catch {
      // Skip malformed lines
    }
  }

  // Fallback to cwd-based resolution
  return resolveProjectName()
}

/**
 * Resolve project name from the current session's JSONL file.
 * Reads the JSONL file for the given sessionId and extracts the cwd field.
 * This is more reliable than process.cwd() because hooks and MCP servers
 * may run with a different cwd than the actual Claude Code session.
 */
export function resolveProjectNameFromSession(sessionId?: string): string {
  const sid = sessionId ?? resolveSessionId()
  const projectPath = resolveProjectPath()

  if (projectPath) {
    const projectDir = path.join(os.homedir(), '.claude', 'projects', projectPath)
    const sessionFile = path.join(projectDir, `${sid}.jsonl`)
    try {
      if (fs.existsSync(sessionFile)) {
        const content = fs.readFileSync(sessionFile, 'utf-8')
        return extractProjectNameFromJsonl(content)
      }
    } catch {
      // Fall through
    }

    // Try to find any recent JSONL in the project dir and extract cwd
    try {
      const files = fs.readdirSync(projectDir)
        .filter(f => f.endsWith('.jsonl'))
        .map(f => ({
          name: f,
          mtime: fs.statSync(path.join(projectDir, f)).mtime.getTime(),
        }))
        .sort((a, b) => b.mtime - a.mtime)

      if (files.length > 0) {
        const content = fs.readFileSync(path.join(projectDir, files[0].name), 'utf-8')
        return extractProjectNameFromJsonl(content)
      }
    } catch {
      // Fall through
    }
  }

  return resolveProjectName()
}

/**
 * Extract human-readable conversation from JSONL session file.
 */
export function extractConversationFromJsonl(content: string): string {
  const lines = content.split('\n').filter(l => l.trim())
  const messages: string[] = []

  for (const line of lines) {
    try {
      const entry = JSON.parse(line)
      if (entry.type === 'user' || entry.type === 'assistant') {
        const msg = entry.message
        if (msg?.content) {
          if (typeof msg.content === 'string') {
            messages.push(`[${msg.role}]: ${msg.content}`)
          } else if (Array.isArray(msg.content)) {
            for (const block of msg.content) {
              if (block.type === 'text' && block.text) {
                messages.push(`[${msg.role}]: ${block.text}`)
              } else if (block.type === 'tool_use') {
                messages.push(`[${msg.role}]: [tool: ${block.name}]`)
              }
            }
          }
        }
      }
    } catch {
      // Skip malformed lines
    }
  }

  return messages.join('\n')
}

/**
 * Attempt to extract session information from telemetry logs.
 */
function extractFromTelemetry(_sessionId: string): string | null {
  const telemetryDir = process.env['CLAUDE_TELEMETRY_DIR'] ?? path.join(CLAUDE_DIR, 'telemetry')
  try {
    if (!fs.existsSync(telemetryDir)) {
      return null
    }

    const files = fs.readdirSync(telemetryDir)
      .filter(f => f.endsWith('.json'))
      .sort()
      .slice(-5) // Check last 5 telemetry files

    for (const file of files) {
      try {
        const content = fs.readFileSync(path.join(telemetryDir, file), 'utf-8')
        if (content.includes(_sessionId)) {
          return `[telemetry data for session ${_sessionId}]`
        }
      } catch {
        // Skip unreadable files
      }
    }
  } catch {
    // Telemetry dir not accessible
  }

  return null
}

/**
 * Truncate text to approximate token limit, preserving end (most relevant).
 */
export function truncateToTokenLimit(text: string, charLimit = 60000): string {
  if (text.length <= charLimit) {
    return text
  }

  const truncated = text.slice(text.length - charLimit)
  return `[前略...]\n${truncated}`
}

/**
 * Save the current session's JSONL to DB (on-demand).
 * Reads session JSONL, sanitizes, truncates, and saves as pending.
 * Used by architect's recommend tool — no Stop hook dependency.
 *
 * Requires initDb() to be called before use.
 */
export function saveCurrentSession(options?: {
  sessionId?: string
  transcriptPath?: string
  cwd?: string
}): { sessionId: string; saved: boolean; reason?: string } {
  // Lazy import to avoid circular dependency at module load time
  const { sanitize, shouldSkipAnalysis } = require('./analyzer.js')
  const { saveRawLog } = require('./db.js')

  const sessionId = options?.sessionId ?? resolveSessionId()

  // Read session log: transcriptPath > file-based fallback
  let rawLog: string | null = null

  if (options?.transcriptPath) {
    try {
      if (fs.existsSync(options.transcriptPath)) {
        const content = fs.readFileSync(options.transcriptPath, 'utf-8')
        rawLog = extractConversationFromJsonl(content)
      }
    } catch {
      // Fall through
    }
  }

  if (!rawLog) {
    rawLog = resolveSessionLog(sessionId)
  }

  if (!rawLog) {
    return { sessionId, saved: false, reason: 'session log not found' }
  }

  if (shouldSkipAnalysis(rawLog)) {
    return { sessionId, saved: false, reason: `too short (${rawLog.length} chars)` }
  }

  const sanitized = sanitize(rawLog)
  const truncated = truncateToTokenLimit(sanitized, 60000)

  // Resolve project name
  let projectName: string
  if (options?.cwd) {
    projectName = path.basename(options.cwd)
  } else {
    projectName = resolveProjectNameFromSession(sessionId)
  }

  saveRawLog(sessionId, truncated, projectName)
  return { sessionId, saved: true }
}
