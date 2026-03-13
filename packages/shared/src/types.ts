/** Claude API analysis result — returned by analyzeWithRetry() */
export interface AnalysisResult {
  summary: string
  knowledge: KnowledgeItem[]
  patterns: PatternItem[]
}

/** A single knowledge item extracted from session analysis */
export interface KnowledgeItem {
  category: KnowledgeCategory
  title: string
  content: string
  tags: string[]
}

/** A detected pattern (repeated workflow, tool usage, etc.) */
export interface PatternItem {
  description: string
  occurrences: number
  category: PatternCategory
}

/** Knowledge categories — v1.0 fixed set, additions only (no rename/delete) */
export type KnowledgeCategory = 'skills' | 'mcp' | 'debug' | 'workflow' | 'rule'

/** Pattern categories for candidate detection */
export type PatternCategory = 'mcp_candidate' | 'skills_candidate'

/** analysis_status state machine values */
export type AnalysisStatus = 'pending' | 'processing' | 'completed' | 'failed' | 'skipped'

/** Database row for sessions table */
export interface SessionRow {
  id: string
  recorded_at: string | null
  analyzed_at: string | null
  project: string | null
  summary: string | null
  raw_analysis: string | null
  raw_log: string | null
  analysis_status: AnalysisStatus
  input_tokens: number
  output_tokens: number
  cost_usd: number
  created_at: string
}

/** Database row for knowledge table */
export interface KnowledgeRow {
  id: number
  session_id: string | null
  project: string | null
  category: KnowledgeCategory
  title: string
  content: string
  tags: string
  hit_count: number
  reference_count: number
  last_referenced_at: string | null
  confidence_score: number
  promoted: number
  created_at: string
  updated_at: string
}

/** Database row for patterns table */
export interface PatternRow {
  id: number
  session_id: string | null
  pattern_hash: string
  description: string
  occurrences: number
  initial_estimate: number | null
  last_seen: string | null
  category: PatternCategory
}
