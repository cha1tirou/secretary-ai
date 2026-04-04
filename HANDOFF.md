# LINE AI秘書 — 開発ハンドオフ資料

## 概要
LINEで動くAI秘書。Gmail・Google Calendarと連携し、朝のブリーフィング・メール返信提案・予定管理を行う。

## 技術スタック
- **Runtime**: Node.js 20 + TypeScript (ESM)
- **Web**: Hono + @hono/node-server
- **DB**: better-sqlite3 (WAL mode)
- **AI**: Claude API (Haiku: 分類/要約/パース, Sonnet: 返信生成)
- **外部API**: LINE Messaging API, Gmail API v1, Google Calendar API v3
- **Cron**: node-cron

## ディレクトリ構成
```
src/
  server.ts                    # エントリポイント。Hono app + cron起動
  types.ts                     # 共通型定義 (Email, CalendarEvent, User, PendingReply)
  handlers/
    webhook.ts                 # LINE Webhook。pending操作 + secretaryへ委譲
  agents/                      # LLM呼び出しはここに集約
    secretary.ts               # メインエージェント（regex simple_command + Sonnet Tool Use agentic loop）
    classifier.ts              # メール分類 + タスク抽出 (dev: regex / prod: Haiku)
    briefing.ts                # ブリーフィング生成 (dev: mock / prod: Haiku)
    reply.ts                   # メール返信生成 (dev: mock / prod: Sonnet) + 文体反映
    calendar-parser.ts         # 自然言語→日時パース (dev: regex / prod: Haiku)
    style-learner.ts           # 送信済みメールから文体学習 (dev: mock / prod: Haiku)
  integrations/
    auth.ts                    # Google OAuth2 (/auth/start, /auth/callback) + トークン復元/refresh
    gmail.ts                   # getUnreadEmails, getSentEmails, getThread, sendReply
    gcal.ts                    # getTodayEvents, getWeekEvents, createEvent
  db/
    schema.sql                 # テーブル定義 (users, conversations, pending_replies, processed_emails)
    queries.ts                 # DB操作関数
  cron/
    morning.ts                 # 毎朝8時ブリーフィング
    auto-draft.ts              # 5分おき未読メールチェック→自動ドラフト生成
```

## DBスキーマ
- **users**: user_id(PK), display_name, gmail_token(JSON), gcal_token(JSON), writing_style, briefing_hour
- **conversations**: id, user_id, role, content, intent, created_at ※未活用
- **pending_replies**: id, user_id, thread_id, to_address, subject, draft_content, status(pending/hold/sent/cancelled/modified), sent_at
- **processed_emails**: message_id(PK), user_id, category(reply_urgent/reply_later/important_info/newsletter/other), processed_at
- **tasks**: id, user_id, title, description, due_date, source(manual/email), source_id, status(todo/done/cancelled), notified_at, created_at

## メール分類システム
新着メールをAI（Haiku）で5カテゴリに自動分類:
| カテゴリ | 通知タイミング | 内容 |
|---|---|---|
| reply_urgent | 5分おきチェック→即通知 | 返信案付きQuickReply |
| reply_later | 10時/15時/19時まとめ | 返信案付きQuickReply |
| important_info | ブリーフィングで表示 | タイトル一覧 |
| newsletter | ブリーフィングで表示 | 件数のみ |
| other | 通知なし | — |

## プラン設計

| プラン | 月額 | 処理方式 | 機能 |
|---|---|---|---|
| trial | 無料（7日） | pro同等 | 全機能 |
| light | 480円 | lightPlanProcessor（regex固定処理） | ブリーフィング・定型コマンド・メール分類 |
| pro | 980円 | proAgentLoop（Sonnet + Tool Use） | 全機能 + AI自由対話 |
| expired | — | プラン案内のみ | — |

### コスト試算
- light: 約0.04円/回（LLM不使用）× 1日30回 = 約36円/月
- pro: simple_command約0.04円 + complex約3円/回 × 1日10回 = 約900円/月
- 決済: Stripe（後で実装）。決済公開まで全ユーザーpro相当で利用可

### 処理フロー
1. `handleWithSecretary()` → `checkPlan()` でプラン判定
2. expired → プラン案内メッセージ
3. light → `lightPlanProcessor()`（regex定型コマンド）
4. trial/pro → `matchSimpleCommand()` → hit: 固定処理 / miss: `proAgentLoop()`

### lightPlanProcessor 定型コマンド
- 今日の予定 / 今週の予定 / 空き時間
- 未読メール / 急ぎメール
- タスク一覧 / タスク追加
- 保留メール一覧
- それ以外 → プロプランへの案内

## 主要フロー

### LINE Webhook (POST /webhook)
1. 署名検証 → 即200返却（バックグラウンド処理）
2. followイベント → ユーザー登録(trial) + ウェルカムメッセージ + Google認証案内
3. pending操作（送信/保留/キャンセル #番号）→ 直接処理
4. それ以外 → secretary.ts に委譲（プラン分岐あり）
5. 「確認中...」をreplyMessageで即返し、結果はpushMessageで後送

### secretary.ts（ハイブリッドアーキテクチャ）
**Step 1: regex simple_command** — LLM不使用、固定処理
- today_schedule, week_schedule, free_time, unread_email
- task_list, task_add, task_done, hold_list

**Step 2: Sonnet + Tool Use (agentic loop)** — 複雑なリクエスト
- 10個のtools: get_today_events, get_week_events, get_free_slots, create_calendar_event, search_emails, get_tasks, create_task, update_task_status, get_hold_emails
- 最大3ターンのloop（tool_use → tool_result → 繰り返し）
- 会話履歴: conversationsテーブルから直近5件をmessagesに含める
- dev時はmock応答（LLM不使用）

### 自動ドラフト (cron)
- **5分おき**: 新着メール分類 + reply_urgent即通知 + タスク自動抽出
- **10時/15時/19時**: reply_laterまとめ通知
- important_info/newsletter: 分類のみ（通知はブリーフィングで）

### ブリーフィング (cron 毎朝8時)
今日の予定 + 未読メールサマリー + 重要お知らせ一覧 + メルマガ件数

## 環境変数 (.env)
```
LINE_CHANNEL_ACCESS_TOKEN=xxx
LINE_CHANNEL_SECRET=xxx
LINE_USER_ID=U0c1ff4e8bd4831f301f7b8477ac83331
GOOGLE_CLIENT_ID=xxx
GOOGLE_CLIENT_SECRET=xxx
GOOGLE_REDIRECT_URI=http://localhost:3000/auth/callback
ANTHROPIC_API_KEY=         # prod時に必要
PORT=3000
DB_PATH=./data/secretary.db
DATABASE_URL=sqlite:./data/secretary.db  # 将来: postgres://user:pass@host:5432/secretary
TZ=Asia/Tokyo
NODE_ENV=development       # dev: LLMモック / prod: 実LLM呼び出し
```

## インフラ

### 現在（α版）
- **ホス��ィング**: Railway（東京リージョン）
- **DB**: SQLite (better-sqlite3) — Railwayのpersistent volume上
- **ビルド**: `tsc` → `node dist/server.js`
- **�����ファイル**: `railway.toml`, `Procfile`
- **ヘルスチェック**: `GET /health`
- **デプロイ**: `railway up`

### ロードマップ
| フェーズ | 環境 | DB | 用途 |
|---|---|---|---|
| α版��現在） | Railway 東京 | SQLite | 開発・αテスト |
| β版 | Railway or Fly.io | SQLite (Litefs) | βテスト（〜50ユーザー） |
| 本番 | AWS EC2 + RDS | PostgreSQL | 有料ユーザー50人超え |

### SQLite → PostgreSQL 移行メモ
- **移行タイミング**: 有料ユーザー50人超え
- **schema.sql**: 各カラムに `[PG]` コメントで移行先の型を記載済み
- **queries.ts**: SQLite固有部分に `[PG]` コメントで移行手順を記載済み
- **主な変更点**: AUTOINCREMENT→SERIAL, ?→$1, lastInsertRowid→RETURNING id, INSERT OR IGNORE→ON CONFLICT DO NOTHING, PRAGMA→不要, datetime('now','localtime')→NOW(), TEXT→VARCHAR/JSONB/DATE
- **推奨**: drizzle-orm で抽象化すると移行コスト最小

## 絶対に守るルール (CLAUDE.md)
1. LINE応答は3秒以内。重い処理の前に確認中メッセージを先に返す
2. Gmail送信はpending_repliesテーブルを必ず経由する
3. LLM呼び出しはsrc/agents/に集約する
4. OAuth2トークンはDBに保存し期限前にrefreshする
5. エラー時は必ずLINEでユーザーに通知する
6. NODE_ENV=developmentのときはLLMをモックで返す

## 既知の注意点
- DBカラム名はsnake_case、TypeScript型はcamelCase。getUser()はSELECTでASエイリアスを使って変換している
- getPendingReply()はASエイリアス未対応（SELECT *のまま）。必要なら修正が要る
- Google Calendar APIは時間範囲に「存在する」予定を返すため、getTodayEventsでは開始時刻フィルタを追加済み
- conversationsテーブルは定義済みだが未活用（会話履歴の保存・文脈利用は未実装）

## 進捗 (2026-04-04時点)

### 完了
- [x] 共通型定義、DB操作関数
- [x] LINE Webhookオウム返し → intent振り分け
- [x] Google OAuth2認証フロー
- [x] Gmail未読一覧 / スレッド取得 / 送信済み取得 / メール送信
- [x] Google Calendar 取得 / 登録
- [x] ブリーフィング生成 + cron毎朝8時
- [x] 意図解釈 (regex + LLM)
- [x] メール返信生成 + QuickReplyで送信承認
- [x] カレンダー登録（自然言語パース）
- [x] レスポンス3秒対策（即200返却 + バックグラウンド処理）
- [x] 文体学習
- [x] 自動ドラフト（5分おき新着チェック → 返信案をLINE通知）
- [x] メール5カテゴリ自動分類（AI判定 + regexフォールバック）
- [x] カテゴリ別通知（urgent即時 / reply_later 1日3回 / info・newsletterはブリーフィング）
- [x] 保留ボタン + 保留一覧確認機能
- [x] secretary.ts ハイブリッドアーキテクチャ（regex + Sonnet Tool Use）
- [x] webhook.ts 簡素化（pending操作 + secretary委譲のみ）
- [x] コスト最適化（simple_command: ~0.04円 / complex: ~1.5-4.5円）
- [x] ANTHROPIC_API_KEY有無でagentic/mock自動切替

### 未着手・改善候補
- [x] conversationsテーブル活用（会話の文脈保持）→ secretary.tsで直近5件利用
- [ ] OAuthトークン期限切れ時のLINE再認証案内
- [ ] メール返信案の編集機能（ユーザーが修正してから送信）
- [ ] 週間ブリーフィング（月曜に今週の予定まとめ）
- [ ] NODE_ENV=production本番デプロイ
- [ ] テストコード
- [ ] getPendingReplyのsnake_case→camelCase変換
