import Anthropic from '@anthropic-ai/sdk'
import type { AnalysisResult } from './types.js'

/** Minimum log length to analyze (avoid hallucination on short logs) */
const MIN_LOG_LENGTH = 500

/** Retry delays in ms (exponential backoff: 1s, 2s, 4s) */
const RETRY_DELAYS = [1000, 2000, 4000]

/** API request timeout in ms */
const API_TIMEOUT = 8000

/** Analysis model (haiku series for speed/cost) */
function getAnalysisModel(): string {
  return process.env['CLAUDE_MEMORY_ANALYSIS_MODEL']
    ?? process.env['CLAUDE_MEMORY_MODEL']
    ?? 'claude-haiku-4-5-20251001'
}

/**
 * Sanitize patterns — order matters: more specific patterns first.
 */
const SANITIZE_PATTERNS: Array<{ name: string; pattern: RegExp }> = [
  { name: 'ssh-private-key', pattern: /-----BEGIN (?:RSA |EC |DSA |OPENSSH )?PRIVATE KEY-----[\s\S]*?-----END (?:RSA |EC |DSA |OPENSSH )?PRIVATE KEY-----/g },
  { name: 'aws-access-key', pattern: /(?:AKIA|ABIA|ACCA|ASIA)[0-9A-Z]{16}/g },
  { name: 'aws-secret-key', pattern: /(?:aws_secret_access_key|AWS_SECRET_ACCESS_KEY)\s*[=:]\s*['"]?[A-Za-z0-9/+=]{40}['"]?/g },
  { name: 'github-pat', pattern: /gh[ps]_[A-Za-z0-9_]{36,255}/g },
  { name: 'github-pat-fine', pattern: /github_pat_[A-Za-z0-9_]{22,255}/g },
  { name: 'api-key-sk', pattern: /sk-[A-Za-z0-9-_]{20,}/g },
  { name: 'api-key-generic', pattern: /(?:api[_-]?key|apikey|api[_-]?secret)\s*[=:]\s*['"]?[A-Za-z0-9\-_.]{20,}['"]?/gi },
  { name: 'bearer-token', pattern: /Bearer\s+[A-Za-z0-9\-._~+/]+=*/g },
  { name: 'env-secret', pattern: /(?:PASSWORD|SECRET|TOKEN|PRIVATE_KEY|API_KEY|AUTH)\s*[=:]\s*['"]?[^\s'"]+['"]?/gi },
  { name: 'db-url', pattern: /(?:postgres(?:ql)?|mysql|mongodb(?:\+srv)?|redis):\/\/[^:]+:[^@]+@[^\s'"]+/gi },
  { name: 'hex-secret', pattern: /(?:secret|token|password|credential)\s*[=:]\s*['"]?[0-9a-fA-F]{32,}['"]?/gi },
]

/**
 * Sanitize raw log by replacing sensitive patterns with [REDACTED].
 */
export function sanitize(text: string): string {
  let result = text
  for (const { pattern } of SANITIZE_PATTERNS) {
    pattern.lastIndex = 0
    result = result.replace(pattern, '[REDACTED]')
  }
  return result
}

/**
 * Check if a log should be skipped from analysis.
 */
export function shouldSkipAnalysis(rawLog: string): boolean {
  return rawLog.length < MIN_LOG_LENGTH
}

/**
 * Calculate API cost based on token usage.
 */
export function calculateCost(inputTokens: number, outputTokens: number): number {
  const inputCost = (inputTokens / 1_000_000) * 0.80
  const outputCost = (outputTokens / 1_000_000) * 4.00
  return inputCost + outputCost
}

const ANALYSIS_PROMPT = `You are a knowledge extraction system. Analyze the following Claude Code session log and extract structured knowledge.

Rules:
- Extract ONLY factual, reusable knowledge from the session
- Do NOT hallucinate or infer information not present in the log
- Each knowledge item must be self-contained and actionable
- Titles must be under 20 characters
- Tags should be lowercase, single-word
- Project-specific information (IP addresses, internal hostnames, customer names) must be category="rule"
- If no meaningful knowledge can be extracted, return empty arrays

Categories:
- skills: Reusable procedures, setup steps, workflows
- mcp: Tool integrations, API patterns, automation opportunities
- debug: Debugging techniques, error resolution patterns
- workflow: Development workflow optimizations
- rule: Project-specific rules, constraints, configurations

Pattern categories:
- mcp_candidate: Repeated tool/API usage that could be automated
- skills_candidate: Repeated manual procedures that could be documented

Respond with valid JSON only, no markdown:
{
  "summary": "One-sentence summary of the session",
  "knowledge": [
    {
      "category": "skills|mcp|debug|workflow|rule",
      "title": "Short title (<20 chars)",
      "content": "Detailed, actionable content",
      "tags": ["tag1", "tag2"]
    }
  ],
  "patterns": [
    {
      "description": "Description of the repeated pattern",
      "occurrences": 1,
      "category": "mcp_candidate|skills_candidate"
    }
  ]
}

Session log:
`

/**
 * Analyze a session log using Claude API with retry logic.
 */
export async function analyzeWithRetry(
  rawLog: string,
  apiKey?: string
): Promise<{ result: AnalysisResult; inputTokens: number; outputTokens: number }> {
  const key = apiKey ?? process.env['ANTHROPIC_API_KEY']
  if (!key) {
    throw new Error('ANTHROPIC_API_KEY not configured')
  }

  const client = new Anthropic({ apiKey: key })
  let lastError: Error | null = null

  for (let attempt = 0; attempt <= RETRY_DELAYS.length; attempt++) {
    try {
      const response = await client.messages.create({
        model: getAnalysisModel(),
        max_tokens: 4096,
        temperature: 0,
        messages: [{ role: 'user', content: ANALYSIS_PROMPT + rawLog }],
      }, {
        signal: AbortSignal.timeout(API_TIMEOUT),
      })

      const textBlock = response.content.find(b => b.type === 'text')
      if (!textBlock || textBlock.type !== 'text') {
        throw new Error('No text response from API')
      }

      const parsed = JSON.parse(textBlock.text) as AnalysisResult

      if (!parsed.summary || !Array.isArray(parsed.knowledge) || !Array.isArray(parsed.patterns)) {
        throw new Error('Invalid analysis result structure')
      }

      return {
        result: parsed,
        inputTokens: response.usage.input_tokens,
        outputTokens: response.usage.output_tokens,
      }
    } catch (error: unknown) {
      lastError = error instanceof Error ? error : new Error(String(error))

      if (error instanceof Anthropic.APIError && error.status >= 400 && error.status < 500) {
        throw error
      }

      if (lastError.name === 'AbortError' || lastError.name === 'TimeoutError') {
        throw lastError
      }

      if (attempt < RETRY_DELAYS.length) {
        await new Promise(resolve => setTimeout(resolve, RETRY_DELAYS[attempt]))
      }
    }
  }

  throw lastError ?? new Error('Analysis failed after all retries')
}
