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
 * Extract human-readable conversation from JSONL session file.
 */
function extractConversationFromJsonl(content: string): string {
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
