# claude-memory-kit — CLAUDE.md

このファイルはプロジェクトの憲法。実装中は常にここに立ち返ること。

## 設計書

**全設計判断の根拠は `docs/design.md`（設計書 v16.0）にある。**
コードを書く前に必ず該当セクションを確認すること。
コードを見ても逆算できない判断は §12「設計上の重要判断」に記録されている。

---

## 絶対に守るルール（違反禁止）

### パッケージ依存
```
recorder  → shared   ✅
architect → shared   ✅
recorder  ↔ architect ❌ 絶対禁止
```
共有ロジックは必ず `shared/` に置く。architect が recorder を import したら即座に指摘を受ける。

### フックの終了コード
Stop フック・PreToolUse フック内のあらゆるコードは、成功・失敗・例外問わず **必ず `exit 0`** で終わる。
`exit 1` や未処理例外で落ちると Claude Code の作業がブロックされる。

### DB 書き込みは同期 API
`better-sqlite3` の同期 API のみ使用する。フック内で `await` を使うと、イベントループ完了前にプロセスが終了してデータが消える。

### AI 生成コードの自動登録禁止
`generate_mcp` は `settings.json` を自動書き換えしない。生成後にユーザーへ登録スニペットを表示し、手動登録させる。

---

## 実装順序

```
Step 0（実環境検証）→ shared → recorder → architect
```

**Step 0 が完了するまで recorder・architect のコーディングを開始しない。**
Step 0 の結果によって §8（SKILL.md 読み込み仕様）と §12（提案 UX）の実装方針が変わる。

---

## ファイル別の責務（一言）

| ファイル | 責務 |
|---------|------|
| `shared/src/db.ts` | DB 接続・WAL・`saveRawLog`・`saveAnalysis`（トランザクション必須） |
| `shared/src/session.ts` | セッション ID 解決・ログ取得（3段階フォールバック） |
| `shared/src/types.ts` | `AnalysisResult` / `KnowledgeItem` / `PatternItem` 型定義 |
| `shared/src/similarity.ts` | `findByLevenshtein`（fastest-levenshtein 使用） |
| `shared/src/network.ts` | `isOnline`（TCP 500ms タイムアウト） |
| `recorder/src/cli.ts` | 手動実行用 CLI（Stop フックは使用しない） |
| `shared/src/session.ts:saveCurrentSession` | オンデマンドセッション保存（recommend 時に呼ばれる） |
| `recorder/src/analyzer.ts` | Claude API 分析ロジック・リトライ・プロンプト定数 |
| `recorder/src/index.ts` | recorder MCP サーバーエントリ |
| `architect/src/cli.ts` | PreToolUse フック用 CLI。ロックファイル O_EXCL 制御 |
| `architect/src/detector.ts` | 候補検出 LEFT JOIN 1クエリ（N+1 禁止） |
| `architect/src/generator.ts` | SKILL.md・MCP コード生成（sonnet 系列） |
| `architect/src/index.ts` | architect MCP サーバーエントリ |

---

## キーとなる設計判断（コード中で迷ったら）

- **`saveAnalysis()` はトランザクション必須**: `UPDATE sessions → upsertKnowledge × N → upsertPattern × M` をアトミックに。
- **楽観ロック**: `UPDATE ... WHERE analysis_status='pending'` → `changes=0` なら他プロセスが先取り → skip。2重分析を防ぐ。
- **`temperature: 0` 必須**: ブレがあると `hit_count` が重複爆発する。
- **`pending` は失敗ではない**: 「処理予定」。`failed` のみ次回 `pending` にリセットして再試行。`skipped` は終端。
- **FS が Ground Truth**: `promoted=TRUE` かつファイルなし → `promoted=FALSE` にリセット。逆はしない。
- **セッション保存はオンデマンド**: Stop フックは `/exit` で発火しないため、`recommend` ツール呼び出し時に `saveCurrentSession()` で現セッションを保存する。Stop フックでの自動保存は行わない。

---

## Definition of Done（v1.0）

実装完了の判断は `docs/design.md` §15 の Blocking チェックリストで行う。
全項目にチェックが入るまで v1.0 と言わない。
