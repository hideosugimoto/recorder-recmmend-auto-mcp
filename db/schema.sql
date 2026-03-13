-- Claude Memory Kit — Database Schema
-- Version: 1.0.0
-- Engine: better-sqlite3 (WAL mode)

CREATE TABLE IF NOT EXISTS sessions (
  id               TEXT PRIMARY KEY,
  recorded_at      DATETIME,
  analyzed_at      DATETIME,
  project          TEXT,
  summary          TEXT,
  raw_analysis     TEXT,
  raw_log          TEXT,
  analysis_status  TEXT DEFAULT 'pending',
  input_tokens     INTEGER DEFAULT 0,
  output_tokens    INTEGER DEFAULT 0,
  cost_usd         REAL    DEFAULT 0.0,
  created_at       DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS knowledge (
  id                   INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id           TEXT REFERENCES sessions(id) ON DELETE SET NULL,
  project              TEXT,
  category             TEXT,
  title                TEXT,
  content              TEXT,
  tags                 TEXT,
  hit_count            INTEGER DEFAULT 1,
  reference_count      INTEGER DEFAULT 0,
  last_referenced_at   DATETIME,
  confidence_score     REAL DEFAULT 1.0,
  promoted             BOOLEAN DEFAULT FALSE,
  created_at           DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at           DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS patterns (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id       TEXT,
  pattern_hash     TEXT UNIQUE,
  description      TEXT,
  occurrences      INTEGER DEFAULT 1,
  initial_estimate INTEGER,
  last_seen        DATETIME,
  category         TEXT
);

CREATE INDEX IF NOT EXISTS idx_knowledge_title    ON knowledge(title);
CREATE INDEX IF NOT EXISTS idx_knowledge_category ON knowledge(category);
CREATE INDEX IF NOT EXISTS idx_knowledge_project  ON knowledge(project);
CREATE INDEX IF NOT EXISTS idx_sessions_status    ON sessions(analysis_status);
