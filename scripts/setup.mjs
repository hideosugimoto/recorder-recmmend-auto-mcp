#!/usr/bin/env node
/**
 * claude-memory-kit setup script
 *
 * Usage:
 *   npm run setup              # interactive (default: ~/.claude/settings.json)
 *   npm run setup -- --global  # same as default
 *   npm run setup -- --local   # .claude/settings.json in current project
 *   npm run setup -- --uninstall
 */
import { readFileSync, writeFileSync, copyFileSync, mkdirSync, existsSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { homedir } from 'node:os'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const PROJECT_ROOT = resolve(__dirname, '..')

// ── Config ──────────────────────────────────────────────────────

const RECORDER_SERVER_KEY = 'claude-memory-recorder'
const ARCHITECT_SERVER_KEY = 'claude-memory-architect'

function mcpServersConfig() {
  return {
    [RECORDER_SERVER_KEY]: {
      command: 'node',
      args: [resolve(PROJECT_ROOT, 'packages/recorder/dist/index.js')],
      env: {
        DB_PATH: '~/.claude-memory/memory.db',
      },
    },
    [ARCHITECT_SERVER_KEY]: {
      command: 'node',
      args: [resolve(PROJECT_ROOT, 'packages/architect/dist/index.js')],
      env: {
        DB_PATH: '~/.claude-memory/memory.db',
        SKILLS_OUTPUT_DIR: './.claude/skills',
        MCP_OUTPUT_DIR: './.claude/mcp',
      },
    },
  }
}

function recorderHookCommand() {
  return `node ${resolve(PROJECT_ROOT, 'packages/recorder/dist/cli.js')} save-session`
}

function architectHookCommand() {
  return `node ${resolve(PROJECT_ROOT, 'packages/architect/dist/cli.js')} startup-check`
}

// ── Helpers ─────────────────────────────────────────────────────

function settingsPath(mode) {
  if (mode === 'local') {
    return resolve(process.cwd(), '.claude/settings.json')
  }
  return resolve(homedir(), '.claude/settings.json')
}

function readSettings(path) {
  if (!existsSync(path)) {
    return {}
  }
  try {
    return JSON.parse(readFileSync(path, 'utf-8'))
  } catch (error) {
    console.error(`  error: ${path} is not valid JSON. Fix it manually or delete the file.`)
    process.exit(1)
  }
}

function backup(path) {
  if (existsSync(path)) {
    const backupPath = `${path}.backup-${Date.now()}`
    copyFileSync(path, backupPath)
    return backupPath
  }
  return null
}

/** Find hook entry index by command substring match */
function findHookIndex(hookArray, commandSubstring) {
  return hookArray.findIndex((entry) =>
    entry.hooks?.some((h) => h.command?.includes(commandSubstring))
  )
}

// ── Install ─────────────────────────────────────────────────────

function install(settings) {
  // 1. mcpServers — upsert
  if (!settings.mcpServers) {
    settings.mcpServers = {}
  }
  const servers = mcpServersConfig()
  settings.mcpServers[RECORDER_SERVER_KEY] = servers[RECORDER_SERVER_KEY]
  settings.mcpServers[ARCHITECT_SERVER_KEY] = servers[ARCHITECT_SERVER_KEY]

  // 2. Stop hook — upsert
  if (!Array.isArray(settings.Stop)) {
    settings.Stop = []
  }
  const recorderEntry = {
    matcher: '*',
    hooks: [{ type: 'command', command: recorderHookCommand() }],
  }
  const stopIdx = findHookIndex(settings.Stop, 'recorder/dist/cli.js')
  if (stopIdx >= 0) {
    settings.Stop[stopIdx] = recorderEntry
  } else {
    settings.Stop.push(recorderEntry)
  }

  // 3. PreToolUse hook — upsert (append to existing array)
  if (!Array.isArray(settings.PreToolUse)) {
    settings.PreToolUse = []
  }
  const architectEntry = {
    matcher: '*',
    hooks: [{ type: 'command', command: architectHookCommand() }],
  }
  const ptuIdx = findHookIndex(settings.PreToolUse, 'architect/dist/cli.js')
  if (ptuIdx >= 0) {
    settings.PreToolUse[ptuIdx] = architectEntry
  } else {
    settings.PreToolUse.push(architectEntry)
  }

  return settings
}

// ── Uninstall ───────────────────────────────────────────────────

function uninstall(settings) {
  // Remove mcpServers
  if (settings.mcpServers) {
    delete settings.mcpServers[RECORDER_SERVER_KEY]
    delete settings.mcpServers[ARCHITECT_SERVER_KEY]
  }

  // Remove Stop hook
  if (Array.isArray(settings.Stop)) {
    const idx = findHookIndex(settings.Stop, 'recorder/dist/cli.js')
    if (idx >= 0) settings.Stop.splice(idx, 1)
  }

  // Remove PreToolUse hook
  if (Array.isArray(settings.PreToolUse)) {
    const idx = findHookIndex(settings.PreToolUse, 'architect/dist/cli.js')
    if (idx >= 0) settings.PreToolUse.splice(idx, 1)
  }

  return settings
}

// ── Main ────────────────────────────────────────────────────────

function main() {
  const args = process.argv.slice(2)
  const isUninstall = args.includes('--uninstall')
  const isLocal = args.includes('--local')
  const mode = isLocal ? 'local' : 'global'

  const path = settingsPath(mode)
  const label = mode === 'local' ? path : `~/.claude/settings.json`

  console.log(`\n  claude-memory-kit ${isUninstall ? 'uninstall' : 'setup'}`)
  console.log(`  target: ${label}\n`)

  // Read
  const settings = readSettings(path)

  // Backup
  const backupPath = backup(path)
  if (backupPath) {
    console.log(`  backup: ${backupPath}`)
  }

  // Apply
  const updated = isUninstall ? uninstall(settings) : install(settings)

  // Write
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, JSON.stringify(updated, null, 2) + '\n', 'utf-8')

  if (isUninstall) {
    console.log('  removed: mcpServers, Stop hook, PreToolUse hook')
  } else {
    console.log('  added:   mcpServers (recorder + architect)')
    console.log('  added:   Stop hook (save-session)')
    console.log('  added:   PreToolUse hook (startup-check)')
  }

  console.log(`\n  done. Restart Claude Code to apply.\n`)
}

main()
