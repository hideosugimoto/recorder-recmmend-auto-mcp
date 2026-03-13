// Re-export from shared to maintain package boundary compliance
// analyzer logic lives in shared so both recorder and architect can use it
// without violating the dependency rule: recorder ↔ architect is FORBIDDEN
export {
  sanitize,
  shouldSkipAnalysis,
  analyzeWithRetry,
  calculateCost,
} from '@claude-memory/shared'
