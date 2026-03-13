import { describe, it, expect } from 'vitest'
import { auditGeneratedCode } from './auditor.js'

describe('auditGeneratedCode', () => {
  it('passes safe code', () => {
    const code = `
      import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
      const server = new McpServer({ name: 'test', version: '1.0.0' })
      server.tool('hello', {}, async () => ({ content: [{ type: 'text', text: 'Hello' }] }))
    `
    const result = auditGeneratedCode(code)
    expect(result.safe).toBe(true)
    expect(result.warnings).toHaveLength(0)
  })

  it('detects eval()', () => {
    const result = auditGeneratedCode('const x = eval("1+1")')
    expect(result.safe).toBe(false)
    expect(result.warnings[0].category).toBe('dynamic_execution')
  })

  it('detects new Function()', () => {
    const result = auditGeneratedCode('const fn = new Function("return 42")')
    expect(result.safe).toBe(false)
    expect(result.warnings[0].category).toBe('dynamic_execution')
  })

  it('detects child_process.exec', () => {
    const result = auditGeneratedCode('child_process.exec("rm -rf /")')
    expect(result.safe).toBe(false)
    expect(result.warnings[0].category).toBe('dynamic_execution')
  })

  it('detects SSH directory access', () => {
    const result = auditGeneratedCode('fs.readFileSync("~/.ssh/id_rsa")')
    expect(result.safe).toBe(false)
    expect(result.warnings[0].category).toBe('sensitive_file_access')
  })

  it('detects AWS credentials access', () => {
    const result = auditGeneratedCode('const creds = readFile("~/.aws/credentials")')
    expect(result.safe).toBe(false)
    expect(result.warnings[0].category).toBe('sensitive_file_access')
  })

  it('reports line numbers correctly', () => {
    const code = 'line1\nline2\neval("bad")\nline4'
    const result = auditGeneratedCode(code)
    expect(result.warnings[0].line).toBe(3)
  })

  it('detects multiple issues', () => {
    const code = 'eval("x")\nchild_process.exec("ls")\nreadFile("~/.ssh/key")'
    const result = auditGeneratedCode(code)
    expect(result.safe).toBe(false)
    expect(result.warnings.length).toBeGreaterThanOrEqual(3)
  })
})
