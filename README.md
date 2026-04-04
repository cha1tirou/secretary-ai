# LINE AI秘書

LINEで動くAI秘書。Gmail・Google Calendarと連携し、ブリーフィング・メール返信提案・タスク管理を行う。

## セットアップ

```bash
npm install
cp .env.example .env  # 環境変数を設定
npm run dev            # 開発サーバー起動
```

## 環境変数

| 変数 | 必須 | 説明 |
|---|---|---|
| `LINE_CHANNEL_ACCESS_TOKEN` | Yes | LINE Messaging API |
| `LINE_CHANNEL_SECRET` | Yes | LINE署名検証用 |
| `LINE_USER_ID` | Yes | デフォルトユーザーID |
| `GOOGLE_CLIENT_ID` | Yes | Google OAuth2 |
| `GOOGLE_CLIENT_SECRET` | Yes | Google OAuth2 |
| `GOOGLE_REDIRECT_URI` | Yes | OAuth2コールバックURL |
| `ANTHROPIC_API_KEY` | Yes | Claude API（Sonnet + Haiku） |
| `PORT` | No | サーバーポート（default: 3000） |
| `DB_PATH` | No | SQLiteファイルパス（default: ./data/secretary.db） |
| `DATABASE_URL` | No | 将来のDB切替用 |
| `TZ` | No | タイムゾーン（default: Asia/Tokyo） |
| `NODE_ENV` | No | development / production |

## デプロイ（Railway）

### 初回
```bash
# Railway CLIインストール
npm i -g @railway/cli

# ログイン & プロジェクト作成
railway login
railway init

# 環境変数を設定
railway variables set LINE_CHANNEL_ACCESS_TOKEN=xxx
railway variables set LINE_CHANNEL_SECRET=xxx
railway variables set LINE_USER_ID=xxx
railway variables set GOOGLE_CLIENT_ID=xxx
railway variables set GOOGLE_CLIENT_SECRET=xxx
railway variables set GOOGLE_REDIRECT_URI=https://your-app.railway.app/auth/callback
railway variables set ANTHROPIC_API_KEY=xxx
railway variables set TZ=Asia/Tokyo
railway variables set NODE_ENV=production

# デプロイ
railway up
```

### 以降のデプロイ
```bash
railway up
```

### LINE Webhook URL設定
デプロイ後、Railway のドメインを LINE Developers の Webhook URL に設定:
`https://your-app.railway.app/webhook`

## 開発

```bash
npm run dev      # tsx watch（ホットリロード）
npm run build    # TypeScriptビルド
npm start        # ビルド済みJSで起動
```

## アーキテクチャ

- **Light plan**: regex定型コマンド（LLM不使用）
- **Pro plan**: Claude Sonnet + Tool Use（agentic loop）
- 詳細は `HANDOFF.md` 参照
