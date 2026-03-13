# Claude Memory Kit — システム設計書
**Version 16.0 / 2026-03-13**

---

## 目次

1. [プロジェクト概要](#1-プロジェクト概要)
2. [システム構成](#2-システム構成)
3. [設計原則](#3-設計原則)
4. [既知の制限](#4-既知の制限)
5. [データモデル](#5-データモデル)
6. [MCP-1: recorder](#6-mcp-1-recorder)
7. [MCP-2: architect](#7-mcp-2-architect)
8. [ナレッジ消費パス](#8-ナレッジ消費パス)
9. [技術スタック・動作要件](#9-技術スタック動作要件)
10. [ディレクトリ構成](#10-ディレクトリ構成)
11. [設定リファレンス](#11-設定リファレンス)
12. [設計上の重要判断](#12-設計上の重要判断)
13. [拡張ロードマップ](#13-拡張ロードマップ)
14. [実装前提の検証チェックリスト（Step 0）](#14-実装前提の検証チェックリストstep-0)
15. [v1.0 Definition of Done](#15-v10-definition-of-done)
16. [テスト戦略](#16-テスト戦略)

---

## 1. プロジェクト概要

### 背景と課題

Claude はセッションをまたいだ自律的な学習ができない。
毎回同じ手順を再発見し、同じエラーを踏み直す「再発明コスト」が発生し続ける。

この問題の本質は「記憶がない」ことではなく、
**「構造化された知識として蓄積されていない」** ことにある。

### 解決方針

| 従来 | 本システム |
|------|-----------|
| 会話履歴＝生ログ | 会話履歴＝分析済みナレッジ |
| 都度再発明 | 蓄積から自動生成 |
| 人間がSkillsを手書き | AIがSkills/MCPを提案・生成 |

---

## 2. システム構成

```
セッション A（前回）              セッション B（今回）
│                                  │
│  〜〜〜 作業中 〜〜〜             │  ← 起動（最初のツール実行前）
│                                  │       PreToolUse hook
│  ← 終了（exit / Ctrl+C 等）      │           ↓
│       Stop hook                  │       MCP-2: architect
│           ↓                      │       ① pending セッション A を検出
│       MCP-1: recorder            │       ② Claude API で分析
│       raw_log のみ保存            │       ③「Docker手順が3回。Skills化しますか？」
│       analysis_status='pending'  │
│       即 exit 0                  │  〜〜〜 作業中 〜〜〜
│                                  │
└── SQLite                        └── SQLite
     ↑ recorder が pending で書く       ↑↓ architect が分析・完了を書く
```

**責務分離の原則:**

| フック | 責務 | 制限 | 理由 |
|--------|------|------|------|
| Stop hook (recorder) | raw_log 保存のみ | 1〜2秒以内 | 10秒制限内で確実に完了させる |
| PreToolUse hook (architect) | API分析 + 提案 | 10秒上限 | ユーザー作業前に実行・絶対にブロックしない |

### データフローとトラストバウンダリー

```
[ローカルFS: ~/.claude/]  →  sanitize()  →  [SQLite: raw_log]  →  Claude API  →  [SQLite: knowledge]
    会話履歴・テレメトリ                        pending状態で保持         ↑                分析済みナレッジ
    （機密情報含む可能性）                                         sanitize後のみ送信      （ローカルにのみ残る）

トラストバウンダリー:
  ローカル環境内（信頼）: SQLite / FS / claude-memory-kit プロセス
  外部（非信頼）:        Anthropic API — sanitize() 通過後のデータのみ到達する
```

### パッケージ依存ルール

```
依存方向（→ は「依存してよい」）:
  recorder  → shared   ✅
  architect → shared   ✅
  recorder  ↔ architect ❌ 禁止（独立した MCP サーバー、詳細は §12）
```

共有ロジックは必ず shared に置く。

---

## 3. 設計原則

> **本設計の非機能要件を定義する。後続の全セクションはこの原則に従う。**

### 原則1: Claude Codeの作業を絶対にブロックしない

- 全フック（Stop / PreToolUse）は成功・失敗問わず `exit 0` で終了する
- タイムアウトは必ず設けAbortControllerで強制終了する（10秒上限）
- このシステムが壊れても Claude Code は動き続ける

### 原則2: データロストより遅延分析を選ぶ

- raw_log の即時保存を最優先し、API分析は次回起動時に延期する（2フェーズ設計の根拠）
- `pending` は「失敗」ではなく「処理予定」を意味する
- `skipped`（終端状態）への遷移は明示的な理由がある場合のみ許可する

### 原則3: ファイルシステムを Ground Truth とする

- DB の `promoted` フラグとファイルの実在が乖離した場合、ファイルを信頼する
- `syncPromotedFromDisk()` の方向は常に「ファイルなし → promoted=FALSE へ DB を追従」
- 逆方向（DB に promoted=TRUE → ファイルを生成）は行わない

### 原則4: AI生成コードはユーザーが審査する

- `generate_mcp` は settings.json を自動書き換えしない
- AI が生成したコードを無審査でローカル実行環境に登録するリスクを防ぐため、確認ステップを必ず挟む

---

## 4. 既知の制限

| 制限 | 内容 | 対応方針 |
|------|------|---------|
| 単一マシン前提 | SQLite はローカルファイル。複数マシンのデータ同期は非対応 | v1.3 チーム共有機能で対応予定 |
| 会話履歴取得の不確実性 | `~/.claude/` のファイル構造は Claude Code バージョンに依存 | 3段階フォールバック設計・実環境検証必須（§14 Step 0） |
| sanitize の非完全性 | 構造的に検出不能な機密情報が存在する（詳細は §6） | ドキュメントで明示・`.claudeignore` で追加パターン登録可（v1.2） |
| PreToolUse stdout 到達保証なし | hook の stdout が Claude のコンテキストに入るかは未確認 | 代替設計3案を用意（§12） |
| 初回同意なし（v1.0 未満） | 会話履歴のAPI送信について明示的な同意フローが必要 | v1.0 Blocking 要件として確定（§15 DoD 参照） |

---

## 5. データモデル

> recorder・architect・shared の全パッケージが依存する共有インフラ。
> スキーマ変更は全パッケージに影響するため、変更時は必ずマイグレーションを追加する。
> バージョン管理は `PRAGMA user_version`。`initDb()` 呼び出し時に `runMigrations()` を自動適用（手動実行不要）。

### DBスキーマ

```sql
CREATE TABLE sessions (
  id               TEXT PRIMARY KEY,
  recorded_at      DATETIME,    -- Stopフック実行時刻（saveRawLog 時）
  analyzed_at      DATETIME,    -- API分析完了時刻（saveAnalysis 時）
  project          TEXT,
  summary          TEXT,
  raw_analysis     TEXT,        -- Claude API の分析結果 JSON
  raw_log          TEXT,        -- 生ログ（分析後は NULL にクリア）
  analysis_status  TEXT DEFAULT 'pending',
                                -- pending / processing / completed / failed / skipped
  input_tokens     INTEGER DEFAULT 0,
  output_tokens    INTEGER DEFAULT 0,
  cost_usd         REAL    DEFAULT 0.0,
  created_at       DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE knowledge (
  id                   INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id           TEXT REFERENCES sessions(id) ON DELETE SET NULL,
  -- ON DELETE SET NULL: sessions 削除時に session_id を NULL に（CASCADE だと promoted=TRUE も消える）
  project              TEXT,        -- クロスプロジェクト汚染防止・非正規化して保持
  category             TEXT,        -- skills / mcp / debug / workflow / rule
  title                TEXT,        -- 20文字以内・検索キー
  content              TEXT,
  tags                 TEXT,        -- JSON 配列
  hit_count            INTEGER DEFAULT 1,    -- セッション再出現カウント（自動）
  reference_count      INTEGER DEFAULT 0,    -- 実際に参照された回数（フィードバック）
  last_referenced_at   DATETIME,
  confidence_score     REAL DEFAULT 1.0,     -- 矛盾検出時に低下（0.5 未満は候補から除外）
  promoted             BOOLEAN DEFAULT FALSE, -- Skills/MCP 化済みか
  created_at           DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at           DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE patterns (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id       TEXT,         -- 最初に検出したセッション（FK なし・集計データは独立保持）
  pattern_hash     TEXT UNIQUE,  -- description 正規化の SHA-256 先頭16文字
  description      TEXT,
  occurrences      INTEGER DEFAULT 1,  -- 実測カウント（常に1から開始・Claude推測値は使わない）
  initial_estimate INTEGER,            -- Claude 推測値（参考のみ・スコアには使わない）
  last_seen        DATETIME,
  category         TEXT          -- mcp_candidate / skills_candidate
);

CREATE INDEX idx_knowledge_title    ON knowledge(title);
CREATE INDEX idx_knowledge_category ON knowledge(category);
CREATE INDEX idx_knowledge_project  ON knowledge(project);
CREATE INDEX idx_sessions_status    ON sessions(analysis_status);
```

**型定義:** `AnalysisResult / KnowledgeItem / PatternItem` の3型を `shared/types.ts` に定義する。

### analysis_status 状態遷移

```
                                ┌──────────────────────────────────────┐
                                │  誰が / いつ更新するか                │
   ┌──────────┐                 ├──────────────┬───────────────────────┤
   │ pending  │                 │ pending      │ recorder (Stop)       │
   └────┬─────┘                 │              │ INSERT 時             │
        │                       ├──────────────┼───────────────────────┤
        ↓                       │ processing   │ architect             │
   ┌────────────┐               │              │ 楽観ロック取得直後     │
   │ processing │               ├──────────────┼───────────────────────┤
   └─────┬──────┘               │ completed    │ architect             │
   ┌─────┼──────────┐           │              │ saveAnalysis() 後     │
   ↓     ↓          ↓           ├──────────────┼───────────────────────┤
completed failed   skipped      │ failed       │ architect             │
   │        │                   │              │ analyzeWithRetry 全失敗│
   │        │ (次回 PreToolUse)  ├──────────────┼───────────────────────┤
   │        └──→ pending        │ skipped      │ architect             │
   │             (再試行)        │              │ raw_log=NULL / 4xx / TTL超過│
   ↓                            └──────────────┴───────────────────────┘
(90日後 DELETE)

遷移条件:
  pending    → processing: 楽観ロック UPDATE（changes=1 の場合のみ処理）
  processing → completed:  analyzeWithRetry() 成功 + saveAnalysis() 完了
  processing → failed:     analyzeWithRetry() 全リトライ失敗（5xx / timeout）
  pending    → skipped:    raw_log が空 / 4xx / ログ500文字未満
  failed     → pending:    次回起動時に architect がリセットして再試行
  pending    → skipped:    PENDING_TTL_DAYS（デフォルト7日）を超過
  completed  → DELETE:     RETENTION_DAYS（デフォルト90日）を超過
```

> **楽観ロックの役割:** `UPDATE ... WHERE analysis_status='pending'` は WAL + busy_timeout 下で write lock を取る。複数 Claude Code セッションが同時起動した場合も、片方の UPDATE だけが `changes=1` になることが保証され、2重分析を構造的に防ぐ。

### ナレッジ保持ポリシー

**削除ポリシー（runRetentionCleanup）:**

| 対象 | 自動削除 | 備考 |
|------|---------|------|
| promoted=TRUE | ❌ しない | `force_regenerate_skill` で再生成可 |
| hit_count が閾値以上または参照あり | ❌ しない | 価値があると判断 |
| promoted=FALSE・未参照・低品質 | ✅ する | `list_stale_knowledge` で事前確認可 |
| sessions（90日超・completed） | ✅ する | ON DELETE SET NULL のため knowledge は永続 |
| patterns（180日超） | ✅ する | — |

**表示ポリシー（displayProposals）:**

confidence_score による3段階フィルタを適用する（通常表示 / ⚠️ 要確認ラベル / 除外）。具体的な閾値は `detector.ts` の定数として管理する。

**クリーンアップ実行タイミング:** architect の PreToolUse フック完了後に非同期（`void`）で実行。失敗しても次回自動リトライ。

**DB 容量警告:** 100MB 超で起動時に警告を出す。

### ナレッジの upsert ポリシー

| 条件 | 動作 |
|------|------|
| 類似タイトルあり・promoted=FALSE | hit_count+1・content/tags を最新で上書き（品質向上） |
| 類似タイトルあり・promoted=TRUE | hit_count と confidence_score のみ更新（ユーザー編集を保護） |
| 類似タイトルなし | 新規 INSERT |
| 大幅な内容変化または否定キーワード追加 | confidence_score を低下・review_knowledge で確認を促す |

類似度判定の具体的な閾値・スコア変化量は `similarity.ts` の定数として管理する。

**類似度アルゴリズム:**
- v1.0: Levenshtein 距離（SQLite 拡張不要・日本語対応）
- v1.2以降: Embedding API（件数増加・意味的類似が必要になった時点で移行）

---

## 6. MCP-1: recorder

**Stopフックで自動起動**し、会話履歴とテレメトリを **sanitize → raw_log として SQLite に退避**する。Claude API の分析は行わない。

**ナレッジ操作ツールのパッケージ責務:**

| パッケージ | 担う操作 | 理由 |
|-----------|---------|------|
| recorder | 作成・読み取り・品質確認（`save_knowledge` / `search_knowledge` / `review_knowledge`） | セッション中に使う読み書き系。recorder のみ起動で参照可能にする |
| architect | 生成・無効化・クリーンアップ（`generate_skill` / `invalidate_knowledge` / `list_stale_knowledge` 等） | 生成物への書き込み・削除という破壊的操作を分離し、より慎重なポリシーを適用する |

### ツール定義（インターフェース）

```typescript
// === 自動実行（Stop フックから呼ばれる） ===
recorder.tool("save_session",     { session_id: string })

// === ユーザーが Claude に依頼して使う ===
recorder.tool("save_knowledge",   { content: string, category: "skills"|"mcp"|"debug"|"workflow"|"rule", tags: string[] })
recorder.tool("list_sessions",    { limit: number })
recorder.tool("search_knowledge", { query: string, project?: string })  // 呼び出し時に reference_count+1
recorder.tool("review_knowledge", { id?: number })                      // 省略時: confidence_score <= 0.7 の一覧
recorder.tool("show_cost",        { period?: "today"|"week"|"month", project?: string })
```

### 会話履歴の取得方法

> **past_chats は Claude.ai UI 内部ツールであり、ローカル Node プロセスからは呼び出せない。**

取得手段の優先順位（`resolveSessionLog()`）:

1. `~/.claude/projects/{project-path}/{session_id}.jsonl`（最も正確。Step 0c で確認済み: 2026-03-13）
2. テレメトリログ `~/.claude/telemetry/` 配下の JSON ファイルから操作パターンのみ抽出（ファイル不在・破損行でもクラッシュしない）
3. CLI 引数 `--summary="..."` でセッション終了時に Claude がサマリーを渡す

セッションID解決（`resolveSessionId()`）も3段階フォールバック: `CLAUDE_SESSION_ID` 環境変数 → セッション JSONL ファイル名から抽出 → 起動時刻から生成。

> **Step 0c 検証結果（2026-03-13）:**
> - `~/.claude/sessions/` は存在しない。セッションログは `~/.claude/projects/{project-path}/{session-id}.jsonl`
> - `~/.claude/logs/` は存在しない。テレメトリは `~/.claude/telemetry/`（JSON 形式）
> - project-path はワーキングディレクトリを `-` 区切りに変換したもの（例: `-Users-sugimotohideo-develop-project`）

### プライバシーとデータ送信

会話履歴を Claude API に送って分析するため、**業務上の機密情報が Anthropic に送信される**。

**sanitize() の対象:** API キー類・環境変数の認証情報・GitHub PAT・AWS 認証情報・Bearer トークン・DB 接続 URL の認証情報部分・SSH / TLS 秘密鍵。正規表現パターンの配列で `[REDACTED]` に一括置換。

**sanitize の保護範囲外（構造的に検出不能）:**
- コードコメントに書かれた機密情報
- 変数名が非標準の場合に変数値として現れる認証情報
- 自然言語で会話中に共有された機密（「パスワードはXXXです」等）

→ これらは `--summary` モード（手段3）を選択することで回避可能。完全な秘匿は保証できないことをドキュメントで明示する（v1.2 で `.claudeignore` 対応）。

⚠️ raw_log への保存は sanitize() 通過後のテキストのみ。

**初回同意フローの実装方針（v1.0 Blocking）:**

```
採用: フラグファイル方式
  ~/.claude-memory/consented が存在しない場合のみ同意画面を表示する。
  Y → ファイルを作成して続行 / N またはタイムアウト（30秒）→ API 呼び出しをスキップ・pending を保持
  CI 環境 → 環境変数 CLAUDE_MEMORY_CONSENT=true で bypass 可能

不採用の案:
  readline インタラクティブ: Stopフック内では stdin が使えない可能性がある
  settings.json に consent: true: ユーザーが設定ファイルを直接編集する UX は避ける
```

### 分析プロセス（2フェーズ設計）

```
【フェーズ1: Stop hook — raw_log 退避（recorder）】
会話履歴 + テレメトリ
    ↓ sanitize() でマスキング
    ↓ truncateToTokenLimit()（上限: 60,000文字・末尾優先・"[前略...]"付記）
    ↓ SQLite に raw_log 保存（analysis_status = 'pending'）
    ↓ 即 exit 0（API呼び出しなし・1〜2秒で完了）

【フェーズ2: PreToolUse hook（次回起動時）— API 分析（architect）】
pending セッションを検出 → Claude API 分析 → knowledge/patterns upsert → 提案表示
詳細フローは §7「architect の起動フロー」を参照。
```

### エラーハンドリングとリトライ

- **5xx / ネットワークエラー**: 最大3回リトライ（1s / 2s / 4s 指数バックオフ）→ 全失敗で `failed`
- **4xx / AbortError / TimeoutError（8秒）**: 即 `failed`（リトライしても意味がない）
- **全ケース**: 常に `exit 0`。`failed` は次回起動時に `pending` へリセットして自動再試行

**エラーの記録先と可視化:**

| レイヤー | 記録先 | ユーザーへの通知 |
|---------|--------|----------------|
| フック実行時のエラー | stderr（即時） | Claude Code のコンソールに表示 |
| API 分析失敗 | sessions.analysis_status = `failed` | 次回 PreToolUse 起動時に failed 件数をサマリー表示 |
| 詳細デバッグ | stderr | `DEBUG=claude-memory*` 環境変数で有効化 |

### 分析プロンプト設計

> **⚠️ AIシステムの品質の核心。プロンプトの質がナレッジの質を100%決定する。**

プロンプト本文（few-shot・カテゴリ判定基準・ノイズ除去ルール等）は `analyzer.ts` の定数として実装する。設計書に規定するのは以下のみ：

- **`temperature: 0` 必須**: 同じログが毎回同じナレッジを返すことを保証する。ブレがあると hit_count が重複爆発する
- **500文字未満のログはスキップ**: ハルシネーション（ファントム知識生成）リスクがある
- **プロジェクト固有情報は必ず `category=rule`**: IPアドレス・内部ホスト名・顧客名など、そのプロジェクト外で再利用できない情報を汎用カテゴリに混入させると他プロジェクトで誤用される。判定基準の詳細はプロンプト定数に記述する

---

## 7. MCP-2: architect

**PreToolUse フックで自動起動**し、以下の2つを担う。

1. **pending セッションの分析**: recorder が退避した raw_log を Claude API で分析
2. **Skills/MCP 候補の提案と生成**: 繰り返しパターンを検出してユーザーに提案

### ツール定義（インターフェース）

```typescript
// === 自動実行（PreToolUse フックから呼ばれる） ===
architect.tool("analyze",               { threshold: number })           // デフォルト3

// === ユーザーが Claude に依頼して使う ===
architect.tool("generate_skill",        { knowledge_id: number, output_path?: string })
architect.tool("generate_mcp",          { knowledge_id: number, language?: "typescript"|"python" })
architect.tool("propose_claude_md",     { session_ids?: string[] })
architect.tool("invalidate_knowledge",  { id: number, reason: string })  // confidence=0.0・次回クリーンアップで削除
architect.tool("confirm_knowledge",     { id: number })                  // confidence=1.0 にリセット
architect.tool("force_regenerate_skill",{ knowledge_id: number })        // promoted=TRUE の強制再生成
architect.tool("list_stale_knowledge",  { days_unused?: number })        // デフォルト90日
architect.tool("clear_pending_sessions",{})                              // 未分析ログの明示的破棄
architect.tool("show_cost",             { period?: "today"|"week"|"month", project?: string })
```

### architect の起動フロー（PreToolUse）

```
PreToolUse hook が発火
    ↓ ロックファイルチェック（O_EXCL で atomic 作成・2回目以降は即終了）
    ↓
【フェーズ0: 起動時整合性チェック】
  syncPromotedFromDisk()
    → promoted=TRUE かつ対応ファイルなし → promoted=FALSE にリセット
    ↓
【フェーズ1: pending セッションの分析（最大3件/起動）】
  SELECT sessions WHERE analysis_status='pending'
    AND project = resolveProjectName()    ← 自プロジェクトのみ処理
    ORDER BY recorded_at ASC LIMIT 3
    ↓ なければスキップ
    ↓ checkApiKey() → 未設定なら警告のみ・pending を保持して終了
    ↓ checkMonthlyCostLimit() → 上限超過なら警告してスキップ
    ↓ isOnline() → オフラインなら終了
    ↓ shouldSkipAnalysis(raw_log) → 500文字未満なら skipped
    ↓ 楽観ロック: UPDATE ... WHERE status='pending' → changes=0 なら他プロセスが先取り → skip
    ↓ analyzeWithRetry(raw_log)
        成功: saveAnalysis() → cleanupAfterAnalysis() → status='completed'
        失敗(4xx): status='skipped'
        失敗(5xx): status='failed'（次回再試行）
    ↓
【フェーズ2: 候補検出・提案】
  detectCandidates(threshold=3, project=resolveProjectName())
    ↓ 候補なければ静かに終了
    ↓ 候補あれば displayProposals()（最大5件・非対話・表示のみ）
    ↓
【フェーズ3: クリーンアップ（非同期・失敗しても無視）】
  runRetentionCleanup()
    ↓
【フェーズ4: タイムアウト保護】
  runStartupWithTimeout(10,000ms) → AbortController で中断 → 常に exit 0
```

**コールドスタート:** knowledge 件数 = 0 の場合のみ初回メッセージを1度だけ表示。hit_count < threshold は完全サイレント終了。

### 候補検出（detectCandidates）の設計制約

- knowledge と patterns を LEFT JOIN で1クエリに統合（N+1クエリ禁止）
- フィルタ条件: `hit_count >= threshold AND promoted=FALSE AND confidence_score >= CONFIDENCE_THRESHOLD`（CONFIDENCE_THRESHOLD は detector.ts の定数）
- `project IS NULL` は古いスキーマからの後方互換として含める
- priority スコア = `hitCount × patternOccurrences`（降順ソート）
- suggestedAction は category から自動導出: `mcp → generate_mcp` / `rule → propose_claude_md` / その他 → `generate_skill`
- confidence_score による3段階フィルタ（通常表示 / ⚠️ 要確認 / 除外）を displayProposals で適用

### 生成物の設計判断

**generator.ts:**

| 項目 | 方針 |
|------|------|
| 使用モデル | sonnet 系列（analyzer は haiku 系列・生成物は品質優先） |
| タイムアウト | 30秒 |
| 上書きポリシー | promoted=TRUE → スキップ / FALSE → 再生成 |
| 失敗時 | 例外を throw（ファイル未作成なら DB も更新しない） |

SKILL.md のセクション構成・MCP の必須要素・プロンプト本文は `generator.ts` の定数として実装する。

**slugify():** タイトル全体の SHA-256 先頭6文字をハッシュ接尾辞として必ず付与し、純日本語タイトルの同一パス衝突を防ぐ（例: `"Docker起動手順"` → `"docker--a3f9c1"`）。

**`propose_claude_md()`:** category=rule かつ promoted=FALSE のナレッジを `{cwd()}/.claude/CLAUDE.md` 末尾に追記。既存エントリとの重複はスキップし、追記成功時に promoted=TRUE に更新する。

**`generate_mcp()`:** settings.json は自動書き換えしない。auditGeneratedCode() が危険パターンを検出した場合は生成を中断しユーザーに警告する。生成後に登録スニペットを表示し、ユーザーが確認・手動登録する（原則4参照）。

**auditGeneratedCode() の検出カテゴリ（方針）:**
- **動的コード実行**: `eval` / `new Function` / `child_process.exec` 等のシェルインジェクション系
- **外部通信**: 想定外の URL への fetch / HTTP 呼び出し（Anthropic API 以外）
- **機密ファイルアクセス**: `~/.ssh` / `~/.aws` / `.env` 等への書き込み

検出パターンの実装詳細は `auditor.ts` に集約する。設計書はカテゴリ方針のみ規定する。

---

## 8. ナレッジ消費パス

> **Step 0 検証完了（2026-03-13）: 仮説A が正しい。**
> `~/.claude/skills/` 配下の SKILL.md は Claude Code が自動スキャンし、セッション開始時にシステムプロンプトに含める。
> `generate_skill` はファイル出力のみでよく、settings.json の更新や `@include` は不要。

### §8.1: SKILL.md 読み込み仕様（確定）

- Claude Code は `~/.claude/skills/` および `.claude/skills/` 配下のディレクトリを自動スキャンする
- 各ディレクトリ内の `SKILL.md` をシステムプロンプトに含める
- `generate_skill` は `{SKILLS_OUTPUT_DIR}/{slug}/SKILL.md` を生成するだけでよい
- 追加の設定変更は不要（ファイル配置のみで有効化される）

### エンドツーエンドのナレッジ活用フロー

```
【蓄積】 セッション A で Docker の起動手順を3回確立する
    ↓ Stop hook → recorder が raw_log を pending で保存

【分析】 セッション B 開始時に architect が自動分析
    ↓ knowledge: "Docker起動手順"（hit_count=3）を蓄積

【提案】 architect が「Docker起動手順をSkills化しますか？」と表示
    ↓ generate_skill が .claude/skills/docker-startup-a3f9c1/SKILL.md を生成

【活用】 セッション C 開始時に Claude Code が SKILL.md を読み込む（※仕様は Step 0 で確定）
    ↓ Claude は起動時から Docker 手順を知っている状態になる

【フィードバック】 search_knowledge 呼び出し時に reference_count+1
    ↓ 参照されない知識は 90 日後に自動陳腐化 → 削除
```

---

## 9. 技術スタック・動作要件

| 項目 | 要件 |
|------|------|
| ランタイム | Node.js 20 LTS 以上 |
| 言語 | TypeScript 5.x（strict モード） |
| monorepo 管理 | npm workspaces（v1.0）→ 変更する場合は破壊的変更とみなす |
| DB | better-sqlite3（WAL モード・同期 API でフック内の非同期問題を回避） |
| テスト | vitest |
| パッケージ公開 | v1.1 以降 npm（スコープ: `@claude-memory/recorder`, `@claude-memory/architect`） |

> **なぜ better-sqlite3（同期）か:** Stop フック・PreToolUse フック内では `await` のイベントループ完了前に Node プロセスが終了するリスクがある。同期 API を使うことでフック内の DB 書き込みを確実に完了させる。

---

## 10. ディレクトリ構成

```
claude-memory-kit/
├── packages/
│   ├── shared/
│   │   └── src/
│   │       ├── session.ts     セッションID・ログ取得（3段階フォールバック）
│   │       ├── db.ts          DB接続・WAL初期化・saveRawLog・saveAnalysis・cleanupAfterAnalysis
│   │       ├── types.ts       AnalysisResult / KnowledgeItem / PatternItem 型定義
│   │       ├── similarity.ts  findByLevenshtein（fastest-levenshtein 使用）
│   │       └── network.ts     isOnline（TCP 接続で疎通確認・500ms タイムアウト）
│   ├── recorder/
│   │   └── src/
│   │       ├── index.ts       MCP サーバーエントリ
│   │       ├── cli.ts         Stop フック用 CLI（sanitize → saveRawLog → exit 0）
│   │       ├── analyzer.ts    Claude API 分析ロジック（リトライ・マスキング・プロンプト定数）
│   │       └── db.ts          recorder 固有の SQLite 操作（upsertKnowledge）
│   └── architect/
│       └── src/
│           ├── index.ts       MCP サーバーエントリ
│           ├── cli.ts         PreToolUse フック用 CLI（ロックファイル・O_EXCL 制御）
│           ├── detector.ts    パターン検出（LEFT JOIN 1クエリ・N+1 解消）
│           ├── generator.ts   SKILL.md・MCP コード生成（sonnet 系列・プロンプト定数）
│           └── db.ts          architect 固有の SQLite 操作（楽観ロック・processing 遷移）
├── db/
│   └── schema.sql             スキーマ定義（マイグレーション履歴はコメントで管理）
├── examples/
│   └── settings.json          完全な設定サンプル（ローカル版・npm版）
└── README.md
```

---

## 11. 設定リファレンス

`examples/settings.json` に完全なサンプルを置く。設定の構造は以下の通り：

```
.claude/settings.json に設定するもの:
  mcpServers:
    recorder — DB_PATH / ANTHROPIC_API_KEY を渡す
    architect — DB_PATH / ANTHROPIC_API_KEY / SKILLS_OUTPUT_DIR / MCP_OUTPUT_DIR を渡す
  hooks:
    Stop       → recorder save-session（sanitize → DB 保存 → exit 0）
    PreToolUse → architect startup-check（分析 + 提案 + クリーンアップ）
```

**フックの動作ポリシー:**
- Stop hook: `/exit` / `/clear` / `Ctrl+C` / ウィンドウ閉じるで発火。常に `exit 0` で返す
- PreToolUse ロックファイル: セッションIDをキーにした O_EXCL ロックで同一セッション内の多重起動を防ぐ。セッションIDをファイル名に含めることで、異常終了時のロック残留が次回セッションに影響しない

**npm版への移行（v1.1〜）:** MCP サーバーの起動コマンドを `node` → `npx @latest` に変えるだけ。コードは同一のため DB マイグレーション不要。

### 環境変数リファレンス

| 変数名 | 用途 | デフォルト |
|--------|------|----------|
| `ANTHROPIC_API_KEY` | Anthropic API キー（必須） | — |
| `CLAUDE_MEMORY_ANALYSIS_MODEL` | analyzer モデル（haiku 系列） | haiku 系列最新版 |
| `CLAUDE_MEMORY_GENERATOR_MODEL` | generator モデル（sonnet 系列） | sonnet 系列最新版 |
| `CLAUDE_MEMORY_MODEL` | 両モデルへの後方互換フォールバック | — |
| `CLAUDE_MEMORY_CONSENT` | CI 環境での同意 bypass | — |
| `DB_PATH` | SQLite ファイルパス | `~/.claude-memory/memory.db` |
| `CLAUDE_PROJECT_NAME` | プロジェクト名上書き（モノレポ等） | `path.basename(cwd())` |
| `CLAUDE_TELEMETRY_DIR` | テレメトリログのパス上書き | `~/.claude/logs/` |
| `RETENTION_DAYS` | セッション保持日数 | `90` |
| `PENDING_TTL_DAYS` | pending 有効期限 | `7` |
| `MAX_MONTHLY_COST_USD` | 月次コスト上限 | `5.0` |
| `SKILLS_OUTPUT_DIR` | SKILL.md 出力先 | `./.claude/skills` |
| `MCP_OUTPUT_DIR` | MCP サーバー出力先 | `./.claude/mcp` |

具体的なモデル文字列は `examples/settings.json` を参照。

---

## 12. 設計上の重要判断

コードを見ても逆算できない、アーキテクチャレベルの判断のみを記録する。

---

**【確定】PreToolUse hook の stdout は Claude から見えない**

> **Step 0a 検証結果（2026-03-13）:** stdout は `hookSpecificOutput` JSON 形式での構造化通信にのみ使用される。フリーテキストの echo は Claude のコンテキストに入らない。
> **Step 0b 検証結果（2026-03-13）:** PreToolUse フックはブロッキング動作。Claude Code はフック完了を待つ。

**採用: 案1 — MCP tool の description に提案を動的埋め込み**

```
architect MCP サーバーの analyze ツールの戻り値に提案を含める。
Claude はツール実行結果を読むため、提案が自然に伝わる。
PreToolUse フックは architect MCP の analyze ツールを呼び出すトリガーとして使う。
```

---

**なぜ analyzer.ts は recorder パッケージに置くか**

分析の実行タイミングは architect（PreToolUse）だが、分析ロジック（プロンプト定数・API 呼び出し・リトライ制御）を architect に置くとロジック単体のユニットテストに architect 全体が必要になる。recorder/analyzer.ts として独立させることでロジックを単体テスト可能にする。architect は recorder/analyzer.ts を直接 import せず shared 経由で参照する。ロジックの肥大化時は shared/analyzer.ts への移管を検討する。

---

**なぜ Stopフックで API を呼ばず2フェーズ設計にするか**

Stopフックには Claude Code が課す10秒のタイムアウトがある。旧設計（Stopフックで同期API呼び出し）では fetchハング + リトライ + DB書き込みが重なると制限を超え、raw_log すら保存できずデータが消えるリスクがあった。2フェーズ分離で「Stopフックの10秒制限」と「API呼び出しの不確実性」を完全に切り離す。

---

**なぜ pending SELECT に project フィルタが必要か**

フィルタなしだと、プロジェクト A の pending セッションをプロジェクト B の architect が処理してしまう。プロジェクト A の rule ナレッジ（IPアドレス・固有設定等）がプロジェクト B の CLAUDE.md に混入するクロスプロジェクト汚染が発生する。`project IS NULL` は古いスキーマからの後方互換として含める。

---

**なぜファイルシステムを Ground Truth とするか**

DB の promoted フラグとファイルの実在が乖離した場合（DBクラッシュ・手動削除等）、どちらを信頼すべきかが曖昧だとリカバリ手順が一意に定まらない。「ファイルが最終成果物 = Ground Truth」と宣言することで `syncPromotedFromDisk()` の方向が一意になる（promoted=TRUE かつファイルなし → promoted=FALSE にリセット。逆はしない）。

---

**なぜ generate_mcp は settings.json を自動書き換えしないか**

AI が生成したコードを自動的にローカル MCP サーバーとして登録すると、悪意のある生成物がローカル環境で実行されるリスクがある。auditGeneratedCode() でパターン検出するが完全ではないため、必ずユーザーが確認するステップを挟む（原則4）。

---

**なぜ confidence_score による段階的フィルタを設けるか**

矛盾検出後にユーザーが確認しないまま Skills 化されると、誤った知識が SKILL.md として固定される。confidence_score で品質不明なナレッジを提案から段階的に除外する安全弁を設ける。具体的な閾値は `detector.ts` の定数として管理する。

---

**なぜ analyzer と generator でモデル系列を使い分けるか**

analyzer（haiku 系列）は大量ログを高速・低コストで構造化する目的。generator（sonnet 系列）は生成した SKILL.md や MCP コードが繰り返し参照される成果物なので、品質がユーザー体験に直結する。使用モデルは環境変数で変更可能とし、設計書にモデル名を固定しない。

---

**なぜ temperature=0 にするか**

同じログが毎回異なるナレッジを返すと、upsertKnowledge が「毎回別ナレッジ」として INSERT し続け hit_count が重複爆発する。決定論的な出力が蓄積・集約システムの必須条件。

---

**なぜ hit_count と reference_count を分けるか**

| カラム | 意味 | 更新タイミング |
|--------|------|-------------|
| hit_count | 同じ手順を何セッションで再実施したか（自動） | upsertKnowledge 時 |
| reference_count | 実際にそのナレッジを参照したか（フィードバック） | search_knowledge / generate_skill 呼び出し時 |

hit_count が高くても reference_count=0 のナレッジは「誰にも使われていない死んだ知識」。両方を組み合わせることで真に価値のあるナレッジが判別できる。

---

**プロンプト変更時のカテゴリ移行戦略**

ANALYSIS_PROMPT のカテゴリや判定基準を変更した場合、既存の knowledge レコードは古い判定のまま残る。

| 案 | 方針 | メリット | デメリット |
|---|------|---------|----------|
| **A（採用）** | カテゴリは追加のみ許容・既存を変更しない | シンプル・互換性維持・コストゼロ | 誤分類を修正できない |
| B | プロンプト変更時に promoted=FALSE を全件再分析 | 常に最新分類 | コスト高 |
| C | 次回同一セッション再出現時に自動上書き | 自然に更新される | 更新に時間がかかる |

**採用は案A:** v1.0 では 5カテゴリ（skills / mcp / debug / workflow / rule）を確定版とし変更しない。追加は後方互換だが削除・リネームは破壊的変更。

---

**なぜ v1.x でインターフェース変更を禁止するか**

MCP ツール名・必須パラメータ・DB スキーマを v1.x 内で変更すると、既存ユーザーの設定が無音で壊れる。ツール名の変更はエラーではなく「ツールが見つからない」という無症状の障害になるため発見が遅れる。既存ツール名・必須パラメータは後方互換を維持し、ツールの削除・リネーム・DBスキーマの非後方互換変更は v2.0 まで持ち越す。新しいオプションパラメータの追加は許可。

---

**なぜ generator の失敗時はロールバックしないか**

ファイル書き出し成功 → DB 更新失敗のケースでも、次回 `generate_skill` 呼び出しで上書き再生成されるため実害はない。ロールバックのためにファイルを削除すると「生成済みファイルを消す」という意図しない破壊につながる。「冪等な再実行で修復できる」設計で複雑なロールバックを避ける。

---

**なぜ saveAnalysis() を shared/db.ts に置くか**

recorder/db.ts に置くと architect が recorder 内部を import する境界違反になる。architect は recorder に依存してはならない（両者は独立した MCP サーバー）。shared に置くことで両パッケージが正しく参照できる。`saveAnalysis()` はトランザクション必須: `UPDATE sessions → upsertKnowledge × N → upsertPattern × M` をアトミックに実行し、不整合状態（status='completed' かつ knowledge 空）を防ぐ。

---

## 13. 拡張ロードマップ

| フェーズ | 内容 | 導入方式 |
|---------|------|---------|
| **v1.0** | recorder + architect 基本機能・ローカル動作検証<br>**Step 0（PreToolUse stdout 検証・SKILL.md 読み込み確認）が最優先**<br>コストトラッキング・プロンプト品質基準・pending の project フィルタ<br>**初回同意フロー（Blocking）** | `node` ローカル版 |
| **v1.1** | npm 公開・自動アップデート対応・CI/CD 整備 | `npx @latest` npm版 |
| **v1.2** | フィードバックループ強化（reference_count 活用）<br>矛盾検出強化（Claude API 活用）・.claudeignore 対応 | npm版 |
| **v1.3** | チーム共有機能・プロジェクト別DB対応 | npm版 |
| **v2.0** | ローカル LLM 対応（プライバシー完全解決）<br>Embedding API 対応（Levenshtein → ベクトル類似度） | npm版 |

**CI/CD 方針（v1.1以降）:** PR gate として型チェック・ユニットテスト・Lint を実行。main マージ時に npm publish。セマンティックバージョニング（conventional commits 準拠）。

---

## 14. 実装前提の検証チェックリスト（Step 0）

> **実装着手前に必ず実環境で確認する。これが通らなければコーディングを開始しない。**
> 以下の検証結果によって §8（Skills読み込み仕様）と §12（UX設計）の確定判断が変わる。

```
0a. PreToolUse hook の stdout が Claude のコンテキストに入るか
    結果: NO — stdout は hookSpecificOutput JSON 形式のみ。案1（MCP ツール戻り値）に切り替え。
    検証日: 2026-03-13

0b. PreToolUse hook 実行中のブロッキング挙動
    結果: ブロッキング — Claude Code はフック完了を待つ。
    検証日: 2026-03-13

0c. ~/.claude/ のファイル構造（セッションファイル形式・テレメトリパス）
    結果: sessions/ は不在。セッションログは ~/.claude/projects/{path}/{id}.jsonl
           logs/ は不在。テレメトリは ~/.claude/telemetry/ (JSON形式)
    §6 の手段1・2のパスを修正済み。
    検証日: 2026-03-13

0d. SKILL.md の読み込み仕様（§8 の確定に必須）
    結果: 仮説A（自動スキャン）が正しい。~/.claude/skills/ 配下は自動ロードされる。
    generate_skill はファイル出力のみでよい。§8 に追記済み。
    検証日: 2026-03-13
```

---

## 15. v1.0 Definition of Done

**これが通らなければ v1.0 と言わない。**

### 必須（Blocking）

```
□ Step 0（0a〜0d）の検証結果が記録され、§8（SKILL.md読み込み仕様）と §12（提案UX設計）の確定判断が完了している
□ recorder: Stop フックから save-session が正常実行される
□ recorder: sanitize() が APIキー / GitHub PAT / Bearer トークンをマスクする
□ recorder: saveRawLog() で analysis_status='pending' の行が INSERT される
□ architect: pending セッションを検出して analyzeWithRetry() が呼ばれる
□ architect: 分析成功後 analysis_status が 'completed' に遷移する
□ architect: knowledge テーブルに少なくとも1件の行が INSERT される
□ architect: generate_skill で .claude/skills/{slug}/SKILL.md が生成される
□ recorder: search_knowledge でナレッジが検索できる
□ analysis_status の状態遷移が全パスでテストされている
□ shouldSkipAnalysis() が 500 文字未満のログをスキップする
□ 全 CLI コマンドに --dry-run フラグが実装されている（副作用なしで CI 実行できる）
□ 初回起動時に「会話履歴を Claude API に送信する」旨の同意確認を表示し、
  明示的な YES 応答がない場合は API 呼び出しを行わない
```

### 任意（Non-blocking / v1.1 へ）

```
□ show_cost ツール UI
□ syncPromotedFromDisk の完全実装
□ list_stale_knowledge の UI
□ .claudeignore 対応
□ CI/CD 整備
```

---

## 16. テスト戦略

MCP サーバーと hook は通常のユニットテストだけでは不十分。レイヤーごとに異なる方針を取る。

### テストレイヤーの方針

| レイヤー | フレームワーク | 対象 |
|---------|-------------|------|
| ユニットテスト | vitest | 純粋関数・ロジック層（Claude API 呼び出しはモック） |
| Hook テスト | CLI --dry-run | 副作用なし・フロー検証・CI でも実行可能 |
| 統合テスト（v1.1以降） | GitHub Actions E2E | 実際のDB書き込みを含む全フロー |

**sanitize() は必ずユニットテストで網羅する:**
機密情報マスクの漏れは外部送信につながる。以下のカテゴリをテストケースとして必ず含めること。
- APIキー・Bearer トークン・GitHub PAT・AWS 認証情報・SSH 秘密鍵
- DB 接続 URL の認証情報部分
- 正常なコードが誤ってマスクされないこと（false positive の検証）

**設計制約:** 全 CLI コマンドに `--dry-run` モードを実装すること。副作用（DB書き込み・API呼び出し）なしでフローを検証できることを保証する。

### 統合テスト E2E シナリオ（v1.1 以降）

```
Step 1: recorder save-session を実行
  → sessions に analysis_status='pending' の行が INSERT されること

Step 2: architect startup-check を実行
  → analysis_status が 'completed' に更新されること
  → knowledge / patterns に行が増えること
  → raw_log が NULL になること

Step 3: architect startup-check を再実行
  → pending なし → 候補検出フェーズへ
  → hit_count >= threshold のナレッジがあれば提案が表示されること
```

*This document is the single source of truth for claude-memory-kit development.*
*変更履歴は Git コミット履歴および CHANGELOG.md を参照。*
