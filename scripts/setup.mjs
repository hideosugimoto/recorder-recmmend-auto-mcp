#!/usr/bin/env node
/**
 * claude-memory-kit setup script
 *
 * MCP servers  → ~/.claude.json (mcpServers)
 * Hooks        → ~/.claude/settings.json (hooks.SessionEnd / hooks.PreToolUse)
 *
 * Usage:
 *   npm run setup              # install (global)
 *   npm run setup -- --local   # hooks to .claude/settings.json in current project
 *   npm run setup -- --uninstall
 */
import { readFileSync, writeFileSync, copyFileSync, mkdirSync, existsSync, unlinkSync } from 'node:fs'
import { resolve, dirname, join } from 'node:path'
import { homedir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { execFileSync } from 'node:child_process'
import { createInterface } from 'node:readline'

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

/** Ensure settings.hooks object exists and return it */
function ensureHooksObject(settings) {
  if (!settings.hooks || typeof settings.hooks !== 'object') {
    settings.hooks = {}
  }
  return settings.hooks
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
  const hooks = ensureHooksObject(settings)

  // Migrate: move old top-level hooks into hooks object
  for (const event of ['Stop', 'SessionEnd', 'PreToolUse', 'PostToolUse', 'PreCompact', 'SessionStart']) {
    if (Array.isArray(settings[event])) {
      if (!Array.isArray(hooks[event])) {
        hooks[event] = []
      }
      hooks[event].push(...settings[event])
      delete settings[event]
    }
  }

  // SessionEnd hook — upsert (replaces old Stop hook)
  if (!Array.isArray(hooks.SessionEnd)) {
    hooks.SessionEnd = []
  }
  const recorderEntry = {
    matcher: '*',
    hooks: [{ type: 'command', command: recorderHookCommand(), timeout: 30 }],
  }
  // Remove old Stop-based recorder hook if present
  if (Array.isArray(hooks.Stop)) {
    const oldIdx = findHookIndex(hooks.Stop, 'recorder/dist/cli.js')
    if (oldIdx >= 0) hooks.Stop.splice(oldIdx, 1)
  }
  const seIdx = findHookIndex(hooks.SessionEnd, 'recorder/dist/cli.js')
  if (seIdx >= 0) {
    hooks.SessionEnd[seIdx] = recorderEntry
  } else {
    hooks.SessionEnd.push(recorderEntry)
  }

  // PreToolUse hook — upsert
  if (!Array.isArray(hooks.PreToolUse)) {
    hooks.PreToolUse = []
  }
  const architectEntry = {
    matcher: '*',
    hooks: [{ type: 'command', command: architectHookCommand() }],
  }
  const ptuIdx = findHookIndex(hooks.PreToolUse, 'architect/dist/cli.js')
  if (ptuIdx >= 0) {
    hooks.PreToolUse[ptuIdx] = architectEntry
  } else {
    hooks.PreToolUse.push(architectEntry)
  }

  return settings
}

function uninstallHooks(settings) {
  const hooks = settings.hooks ?? {}

  // Remove SessionEnd hook
  if (Array.isArray(hooks.SessionEnd)) {
    const idx = findHookIndex(hooks.SessionEnd, 'recorder/dist/cli.js')
    if (idx >= 0) hooks.SessionEnd.splice(idx, 1)
  }

  // Remove old Stop hook (migration)
  if (Array.isArray(hooks.Stop)) {
    const idx = findHookIndex(hooks.Stop, 'recorder/dist/cli.js')
    if (idx >= 0) hooks.Stop.splice(idx, 1)
  }

  // Remove legacy top-level Stop hook
  if (Array.isArray(settings.Stop)) {
    const idx = findHookIndex(settings.Stop, 'recorder/dist/cli.js')
    if (idx >= 0) settings.Stop.splice(idx, 1)
  }

  // Remove PreToolUse hook
  if (Array.isArray(hooks.PreToolUse)) {
    const idx = findHookIndex(hooks.PreToolUse, 'architect/dist/cli.js')
    if (idx >= 0) hooks.PreToolUse.splice(idx, 1)
  }

  // Remove legacy top-level PreToolUse hook
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

// ── Consent ─────────────────────────────────────────────────────

const CONSENT_DIR = join(homedir(), '.claude-memory')
const CONSENT_FILE = join(CONSENT_DIR, 'consented')

function hasConsent() {
  if (process.env['CLAUDE_MEMORY_CONSENT'] === 'true') {
    return true
  }
  return existsSync(CONSENT_FILE)
}

function askConsent() {
  return new Promise((resolvePromise) => {
    const rl = createInterface({ input: process.stdin, output: process.stderr })
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
╚══════════════════════════════════════════════════════════╝
`)
    rl.question('  続行しますか？ (Y/n): ', (answer) => {
      rl.close()
      const a = answer.trim().toLowerCase()
      resolvePromise(a === '' || a === 'y' || a === 'yes')
    })
  })
}

function saveConsent() {
  mkdirSync(CONSENT_DIR, { recursive: true })
  writeFileSync(CONSENT_FILE, new Date().toISOString())
}

function removeConsent() {
  try {
    if (existsSync(CONSENT_FILE)) {
      unlinkSync(CONSENT_FILE)
    }
  } catch {
    // ignore
  }
}

// ── Main ────────────────────────────────────────────────────────

async function main() {
  const args = process.argv.slice(2)
  const isUninstall = args.includes('--uninstall')
  const isLocal = args.includes('--local')
  const mode = isLocal ? 'local' : 'global'

  console.log(`\n  claude-memory-kit ${isUninstall ? 'uninstall' : 'setup'}`)

  // ── 0. Consent check (install only) ──
  if (!isUninstall) {
    if (!hasConsent()) {
      const accepted = await askConsent()
      if (!accepted) {
        console.log('\n  セットアップを中断しました。')
        console.log('  同意がないと Stop フックでセッション保存が動作しません。')
        console.log('  再度セットアップするには: npm run setup\n')
        process.exit(0)
        return
      }
      saveConsent()
      console.log('  consent: 同意が記録されました (~/.claude-memory/consented)')
    } else {
      console.log('  consent: 同意済み')
    }
  } else {
    removeConsent()
  }

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
    console.log('  removed: SessionEnd hook, PreToolUse hook (from settings.json)')
    console.log('  removed: consent file (~/.claude-memory/consented)')
  } else {
    console.log('\n  added:   mcpServers → ~/.claude.json (recorder + architect)')
    console.log('  added:   SessionEnd hook (save-session)')
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

main().catch((err) => {
  console.error('  setup error:', err)
  process.exit(1)
})
