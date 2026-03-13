# claude-memory-kit

Claude Code のセッションをまたいだナレッジを自動蓄積し、繰り返しパターンを Skills / MCP サーバーとして自動生成するシステム。

## 解決する課題

Claude はセッション間で記憶を持たない。同じ手順を毎回再発見し、同じエラーを繰り返す「再発明コスト」が発生する。claude-memory-kit は会話履歴を構造化ナレッジとして蓄積し、繰り返し出現するパターンを自動検出・提案する。

## アーキテクチャ

```
セッション A（終了時）              セッション B（起動時）
│                                  │
│  Stop hook                       │  PreToolUse hook
│  └─ recorder: raw_log 保存       │  └─ architect: 分析 → 提案
│     (pending)                    │     「Docker手順を Skills化しますか？」
│                                  │
└── SQLite ←─────────────────────→ └── SQLite
```

**2フェーズ設計:** Stop フックでは raw_log の保存のみ（1-2秒）。API 分析は次回セッション起動時に architect が実行。

## パッケージ構成

```
packages/
├── shared/      DB・セッション解決・分析ロジック等の共通基盤
├── recorder/    Stop フック + MCP サーバー（ナレッジ読み書き）
└── architect/   PreToolUse フック + MCP サーバー（分析・生成・提案）
```

依存ルール: `recorder → shared` / `architect → shared` (recorder と architect は相互依存禁止)

## セットアップ

### 前提条件

- Node.js 20 LTS 以上
- Claude Code がインストール済み
- Anthropic API キー

### インストール

```bash
git clone <repository-url>
cd claude-memory-kit
npm install
npm run build
```

### Claude Code への登録

`.claude/settings.json` に以下を追加:

```json
{
  "mcpServers": {
    "claude-memory-recorder": {
      "command": "node",
      "args": ["./packages/recorder/dist/index.js"],
      "env": {
        "DB_PATH": "~/.claude-memory/memory.db",
        "ANTHROPIC_API_KEY": "${ANTHROPIC_API_KEY}"
      }
    },
    "claude-memory-architect": {
      "command": "node",
      "args": ["./packages/architect/dist/index.js"],
      "env": {
        "DB_PATH": "~/.claude-memory/memory.db",
        "ANTHROPIC_API_KEY": "${ANTHROPIC_API_KEY}",
        "SKILLS_OUTPUT_DIR": "./.claude/skills",
        "MCP_OUTPUT_DIR": "./.claude/mcp"
      }
    }
  },
  "hooks": {
    "Stop": [
      {
        "matcher": "*",
        "hooks": [
          {
            "type": "command",
            "command": "node ./packages/recorder/dist/cli.js save-session"
          }
        ]
      }
    ],
    "PreToolUse": [
      {
        "matcher": "*",
        "hooks": [
          {
            "type": "command",
            "command": "node ./packages/architect/dist/cli.js startup-check"
          }
        ]
      }
    ]
  }
}
```

完全なサンプルは `examples/settings.json` を参照。

## 使い方

### 自動フロー（設定後は操作不要）

1. セッション終了時に recorder が会話履歴を自動保存
2. 次のセッション起動時に architect が自動分析
3. 繰り返しパターンが検出されると提案が表示される

### 初回同意

初回実行時に会話履歴の API 送信について同意確認が表示される。CI 環境では `CLAUDE_MEMORY_CONSENT=true` で bypass 可能。

### recorder MCP ツール

| ツール | 用途 |
|--------|------|
| `save_session` | セッションログの保存（自動） |
| `save_knowledge` | ナレッジの手動登録 |
| `search_knowledge` | ナレッジ検索 |
| `list_sessions` | セッション一覧 |
| `review_knowledge` | 低品質ナレッジの確認 |
| `show_cost` | API コスト表示 |

### architect MCP ツール

| ツール | 用途 |
|--------|------|
| `analyze` | pending セッションの分析（自動） |
| `generate_skill` | SKILL.md の生成 |
| `generate_mcp` | MCP サーバーコードの生成 |
| `propose_claude_md` | CLAUDE.md への追記提案 |
| `invalidate_knowledge` | ナレッジの無効化 |
| `confirm_knowledge` | ナレッジの信頼度リセット |
| `force_regenerate_skill` | promoted ナレッジの再生成 |
| `list_stale_knowledge` | 陳腐化ナレッジの一覧 |
| `clear_pending_sessions` | 未分析ログの破棄 |
| `show_cost` | API コスト表示 |

## 環境変数

| 変数名 | 用途 | デフォルト |
|--------|------|----------|
| `ANTHROPIC_API_KEY` | Anthropic API キー（必須） | - |
| `DB_PATH` | SQLite ファイルパス | `~/.claude-memory/memory.db` |
| `MAX_MONTHLY_COST_USD` | 月次コスト上限 | `5.0` |
| `RETENTION_DAYS` | セッション保持日数 | `90` |
| `PENDING_TTL_DAYS` | pending 有効期限 | `7` |
| `SKILLS_OUTPUT_DIR` | SKILL.md 出力先 | `.claude/skills` |
| `MCP_OUTPUT_DIR` | MCP サーバー出力先 | `.claude/mcp` |

全環境変数の一覧は `docs/design.md` §11 を参照。

## 開発

```bash
npm install
npm run build
npm test
npm run typecheck
```

### テスト

```bash
npm test              # 全テスト実行
npm run test:watch    # ウォッチモード
```

### dry-run モード

副作用なしでフローを検証:

```bash
node packages/recorder/dist/cli.js save-session --dry-run
node packages/architect/dist/cli.js startup-check --dry-run
```

## 設計原則

1. **Claude Code を絶対にブロックしない** - 全フックは常に exit 0
2. **データロストより遅延分析** - raw_log の即時保存を最優先
3. **FS が Ground Truth** - DB とファイルの乖離時はファイルを信頼
4. **AI 生成コードはユーザーが審査** - settings.json の自動書き換え禁止

詳細は `docs/design.md` を参照。

## ライセンス

MIT
