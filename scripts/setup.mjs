#!/usr/bin/env node
/**
 * claude-memory-kit setup script
 *
 * MCP servers  → ~/.claude.json (mcpServers)
 * Hooks        → ~/.claude/settings.json (Stop / PreToolUse)
 *
 * Usage:
 *   npm run setup              # install (global)
 *   npm run setup -- --local   # hooks to .claude/settings.json in current project
 *   npm run setup -- --uninstall
 */
import { readFileSync, writeFileSync, copyFileSync, mkdirSync, existsSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { homedir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { execFileSync } from 'node:child_process'

const __dirname = dirname(fileURLToPath(import.meta.url))
const PROJECT_ROOT = resolve(__dirname, '..')

// ── Config ──────────────────────────────────────────────────────

const RECORDER_SERVER_KEY = 'claude-memory-recorder'
const ARCHITECT_SERVER_KEY = 'claude-memory-architect'

function mcpServersConfig() {
  return {
    [RECORDER_SERVER_KEY]: {
      type: 'stdio',
      command: 'node',
      args: [resolve(PROJECT_ROOT, 'packages/recorder/dist/index.js')],
      env: {
        DB_PATH: '~/.claude-memory/memory.db',
      },
    },
    [ARCHITECT_SERVER_KEY]: {
      type: 'stdio',
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

// ── Paths ───────────────────────────────────────────────────────

/** MCP servers are registered in ~/.claude.json */
function claudeJsonPath() {
  return resolve(homedir(), '.claude.json')
}

/** Hooks are registered in ~/.claude/settings.json */
function settingsPath(mode) {
  if (mode === 'local') {
    return resolve(process.cwd(), '.claude/settings.json')
  }
  return resolve(homedir(), '.claude/settings.json')
}

// ── Helpers ─────────────────────────────────────────────────────

function readJson(path) {
  if (!existsSync(path)) {
    return {}
  }
  try {
    return JSON.parse(readFileSync(path, 'utf-8'))
  } catch {
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

function writeJson(path, data) {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, JSON.stringify(data, null, 2) + '\n', 'utf-8')
}

/** Find hook entry index by command substring match */
function findHookIndex(hookArray, commandSubstring) {
  return hookArray.findIndex((entry) =>
    entry.hooks?.some((h) => h.command?.includes(commandSubstring))
  )
}

// ── MCP Servers (claude.json) ───────────────────────────────────

function installMcpServers(claudeJson) {
  if (!claudeJson.mcpServers) {
    claudeJson.mcpServers = {}
  }
  const servers = mcpServersConfig()
  claudeJson.mcpServers[RECORDER_SERVER_KEY] = servers[RECORDER_SERVER_KEY]
  claudeJson.mcpServers[ARCHITECT_SERVER_KEY] = servers[ARCHITECT_SERVER_KEY]
  return claudeJson
}

function uninstallMcpServers(claudeJson) {
  if (claudeJson.mcpServers) {
    delete claudeJson.mcpServers[RECORDER_SERVER_KEY]
    delete claudeJson.mcpServers[ARCHITECT_SERVER_KEY]
  }
  return claudeJson
}

// ── Hooks (settings.json) ───────────────────────────────────────

function installHooks(settings) {
  // Stop hook — upsert
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

  // PreToolUse hook — upsert
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

function uninstallHooks(settings) {
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

// ── Migrate: remove old mcpServers from settings.json ───────────

function migrateOldMcpServers(settings) {
  let migrated = false
  if (settings.mcpServers) {
    if (settings.mcpServers[RECORDER_SERVER_KEY]) {
      delete settings.mcpServers[RECORDER_SERVER_KEY]
      migrated = true
    }
    if (settings.mcpServers[ARCHITECT_SERVER_KEY]) {
      delete settings.mcpServers[ARCHITECT_SERVER_KEY]
      migrated = true
    }
    // Clean up empty mcpServers object
    if (Object.keys(settings.mcpServers).length === 0) {
      delete settings.mcpServers
    }
  }
  return migrated
}

// ── Main ────────────────────────────────────────────────────────

function main() {
  const args = process.argv.slice(2)
  const isUninstall = args.includes('--uninstall')
  const isLocal = args.includes('--local')
  const mode = isLocal ? 'local' : 'global'

  console.log(`\n  claude-memory-kit ${isUninstall ? 'uninstall' : 'setup'}`)

  // ── 1. MCP servers → ~/.claude.json ──
  const cjPath = claudeJsonPath()
  console.log(`  mcp:   ~/.claude.json`)

  const cjBackup = backup(cjPath)
  if (cjBackup) console.log(`  backup: ${cjBackup}`)
  const claudeJson = readJson(cjPath)

  const updatedCj = isUninstall
    ? uninstallMcpServers(claudeJson)
    : installMcpServers(claudeJson)
  writeJson(cjPath, updatedCj)

  // ── 2. Hooks → ~/.claude/settings.json ──
  const stPath = settingsPath(mode)
  const stLabel = mode === 'local' ? stPath : '~/.claude/settings.json'
  console.log(`  hooks: ${stLabel}`)

  const stBackup = backup(stPath)
  if (stBackup) console.log(`  backup: ${stBackup}`)
  const settings = readJson(stPath)

  // Migrate: remove old mcpServers from settings.json
  const didMigrate = migrateOldMcpServers(settings)
  if (didMigrate) {
    console.log('  migrated: removed old mcpServers from settings.json')
  }

  const updatedSt = isUninstall
    ? uninstallHooks(settings)
    : installHooks(settings)
  writeJson(stPath, updatedSt)

  // ── 3. Summary ──
  if (isUninstall) {
    console.log('\n  removed: mcpServers (from ~/.claude.json)')
    console.log('  removed: Stop hook, PreToolUse hook (from settings.json)')
  } else {
    console.log('\n  added:   mcpServers → ~/.claude.json (recorder + architect)')
    console.log('  added:   Stop hook (save-session)')
    console.log('  added:   PreToolUse hook (startup-check)')

    // Import past session history
    console.log('\n  importing past session history...')
    try {
      const importScript = resolve(PROJECT_ROOT, 'scripts/import-history.mjs')
      execFileSync('node', [importScript], { stdio: 'inherit' })
    } catch {
      console.log('  warning: history import failed (non-blocking)')
    }
  }

  console.log(`\n  done. Restart Claude Code to apply.\n`)
}

main()
