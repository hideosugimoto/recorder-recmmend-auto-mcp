/**
 * Audit generated code for dangerous patterns.
 * Categories: dynamic code execution, external communication, sensitive file access.
 */

export interface AuditResult {
  safe: boolean
  warnings: AuditWarning[]
}

export interface AuditWarning {
  category: 'dynamic_execution' | 'external_communication' | 'sensitive_file_access'
  pattern: string
  line: number
  message: string
}

const DANGEROUS_PATTERNS: Array<{
  category: AuditWarning['category']
  pattern: RegExp
  message: string
}> = [
  // Dynamic code execution
  { category: 'dynamic_execution', pattern: /\beval\s*\(/g, message: 'eval() detected — potential code injection' },
  { category: 'dynamic_execution', pattern: /new\s+Function\s*\(/g, message: 'new Function() detected — dynamic code execution' },
  { category: 'dynamic_execution', pattern: /child_process\s*\.\s*exec\s*\(/g, message: 'child_process.exec() detected — shell injection risk' },
  { category: 'dynamic_execution', pattern: /child_process\s*\.\s*execSync\s*\(/g, message: 'child_process.execSync() detected — shell injection risk' },
  { category: 'dynamic_execution', pattern: /require\s*\(\s*[^'"]/g, message: 'Dynamic require() detected' },
  { category: 'dynamic_execution', pattern: /vm\s*\.\s*runInNewContext/g, message: 'vm.runInNewContext() detected' },

  // External communication
  { category: 'external_communication', pattern: /(?:fetch|axios|got|request)\s*\(\s*['"][^'"]*(?!api\.anthropic\.com)/g, message: 'External HTTP request to non-Anthropic URL' },
  { category: 'external_communication', pattern: /https?:\/\/(?!api\.anthropic\.com)[^\s'"]+/g, message: 'External URL reference' },
  { category: 'external_communication', pattern: /net\s*\.\s*createServer/g, message: 'Network server creation detected' },
  { category: 'external_communication', pattern: /dgram\s*\.\s*createSocket/g, message: 'UDP socket creation detected' },

  // Sensitive file access
  { category: 'sensitive_file_access', pattern: /~\/\.ssh/g, message: 'SSH directory access detected' },
  { category: 'sensitive_file_access', pattern: /~\/\.aws/g, message: 'AWS credentials directory access detected' },
  { category: 'sensitive_file_access', pattern: /\.env(?:\.|$)/g, message: '.env file access detected' },
  { category: 'sensitive_file_access', pattern: /\/etc\/shadow/g, message: '/etc/shadow access detected' },
  { category: 'sensitive_file_access', pattern: /\/etc\/passwd/g, message: '/etc/passwd access detected' },
]

/**
 * Audit generated code for dangerous patterns.
 * Returns an AuditResult with any warnings found.
 */
export function auditGeneratedCode(code: string): AuditResult {
  const warnings: AuditWarning[] = []
  const lines = code.split('\n')

  for (const { category, pattern, message } of DANGEROUS_PATTERNS) {
    pattern.lastIndex = 0
    let match: RegExpExecArray | null

    while ((match = pattern.exec(code)) !== null) {
      // Find line number
      const beforeMatch = code.slice(0, match.index)
      const lineNumber = beforeMatch.split('\n').length

      warnings.push({
        category,
        pattern: match[0],
        line: lineNumber,
        message,
      })
    }
  }

  return {
    safe: warnings.length === 0,
    warnings,
  }
}
