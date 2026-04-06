# AI秘書 サービス仕様書

## 1. サービス概要

LINEで動くAI秘書。Gmail・Google Calendarと連携し、メール管理・予定管理・タスク管理を自動化する。

- **対象**: ビジネスパーソン（メール・予定管理に時間を使いたくない人）
- **UI**: LINE（メイン）+ Webダッシュボード（メール返信・タスク管理）
- **ステータス**: α版（テストユーザー限定）

## 2. インフラ

| 項目 | 詳細 |
|---|---|
| ホスティング | Railway |
| データベース | SQLite（better-sqlite3, WAL mode） |
| 永続化 | Railway Volume（/app/data/secretary.db） |
| LINE | LINE Messaging API |
| ソースコード | GitHub（cha1tirou/secretary-ai） |
| デプロイ | GitHub pushで自動デプロイ |
| ドメイン | web-production-b2798.up.railway.app |

## 3. 技術スタック

| 技術 | バージョン | 用途 |
|---|---|---|
| Node.js | 20 | ランタイム |
| TypeScript | latest | 言語 |
| Hono | 4.x | HTTPフレームワーク |
| @hono/node-server | | Node.jsアダプター |
| better-sqlite3 | | SQLiteドライバー |
| @anthropic-ai/sdk | | Claude API |
| @line/bot-sdk | 10.x | LINE Messaging API |
| googleapis | | Gmail/Calendar API |
| node-cron | | スケジューラー |
| dotenv | | 環境変数 |

## 4. 環境変数一覧

| 変数名 | 説明 | デフォルト |
|---|---|---|
| LINE_CHANNEL_ACCESS_TOKEN | LINE Bot Token | （必須） |
| LINE_CHANNEL_SECRET | LINE Webhook検証用 | （必須） |
| GOOGLE_CLIENT_ID | Google OAuth2 Client ID | （必須） |
| GOOGLE_CLIENT_SECRET | Google OAuth2 Client Secret | （必須） |
| GOOGLE_REDIRECT_URI | OAuth2 Callback URL | （必須） |
| ANTHROPIC_API_KEY | Claude API Key | （必須） |
| PORT | サーバーポート | 3000 |
| DB_PATH | SQLiteファイルパス | ./data/secretary.db |
| NODE_ENV | 動作モード | production |
| TZ | タイムゾーン | Asia/Tokyo |
| WEATHER_API_KEY | OpenWeatherMap API Key | （任意） |
| WEATHER_CITY | 天気取得都市 | Tokyo |
| BASE_URL | サービスURL | （GOOGLE_REDIRECT_URIから導出） |

## 5. プランと料金

| プラン | 月額 | クレジット | API原価目安 | 利益目安 |
|---|---|---|---|---|
| Trial | 無料（7日間） | 30cr（7日間限定） | 約45円 | — |
| Light | 480円 | 100cr/月 | 約150円 | 約330円 |
| Pro | 980円 | 300cr/月 | 約450円 | 約530円 |

### クレジット制

- 1クレジット ≈ Sonnet 1回呼び出し（約1.5円/回）
- クレジットは毎月1日にリセット（Trialは7日間で終了）
- アラート: 80%到達時（1回）＋残り3以下になった時にLINEへ通知
- 上限到達時は「クレジットが上限に達しました」と案内
- 決済機能は未実装（α版のため全機能継続利用可）

### コスト概算（Anthropic API）

| 操作 | モデル | 概算コスト/回 |
|---|---|---|
| メール分類 | Haiku | ~0.01円 |
| ブリーフィング | Haiku | ~0.05円 |
| AI対話 | Sonnet | ~1.5-4.5円 |
| 返信生成 | Sonnet | ~2-3円 |

## 6. プラン別機能表

| 機能 | Trial | Light | Pro |
|---|---|---|---|
| SimpleCommand（予定・タスク・未読等） | ✅ 無料 | ✅ 無料 | ✅ 無料 |
| AI自由対話・カレンダー登録等 | ✅（30cr） | ✅（100cr） | ✅（300cr） |
| ダッシュボードAI返信生成（Sonnet） | ✅（1cr） | ✅（1cr） | ✅（1cr） |
| メモ書き清書（Haiku） | ✅ 無料 | ✅ 無料 | ✅ 無料 |
| ブリーフィング（Haiku） | ✅ 無料 | ✅ 無料 | ✅ 無料 |
| メール分類（Haiku・キャッシュ） | ✅ 無料 | ✅ 無料 | ✅ 無料 |
| 移動リマインド | ✅ 無料 | ✅ 無料 | ✅ 無料 |
| タスク管理（LINE+Web） | ✅ 無料 | ✅ 無料 | ✅ 無料 |

## 7. 機能一覧

### Push（自動通知）

| 機能 | タイミング | 内容 |
|---|---|---|
| 朝ブリーフィング | 8:00 | 天気・予定・要返信メール・タスク |
| 昼ブリーフィング | 12:00 | 午後の予定・未返信件数 |
| 夜ブリーフィング | 21:00 | 積み残し・明日の予定・明日の天気 |
| 移動リマインド | 予定1時間前 | 場所付き予定の出発提案 |

### Pull（LINE対話）

| コマンド例 | 処理 | クレジット |
|---|---|---|
| 「今日の予定は？」 | SimpleCommand | 無料 |
| 「未読メールある？」 | SimpleCommand | 無料 |
| 「タスクに○○を追加」 | SimpleCommand | 無料 |
| 「山田さんからメール来てる？」 | Sonnet Tool Use | 1cr |
| 「来週火曜に鈴木さんとMTG入れて」 | Sonnet Tool Use | 1cr |

### ダッシュボード（/dashboard）

| 機能 | 説明 |
|---|---|
| 要返信メール一覧 | 受信箱14日分をHaikuで分類・返信済み除外 |
| AIが返信案を作る | Sonnet+カレンダー統合で生成 |
| 要点だけ伝えてAI清書 | メモ→Haikuでビジネスメール化 |
| 返信待ちメール一覧 | 送信済み3-90日で未返信のもの |
| フォローアップメール作成 | Sonnetで丁寧な催促文を生成 |
| 返信案の編集・送信 | textarea切り替えで編集可能 |

### タスク管理（/dashboard/tasks）

| 機能 | 説明 |
|---|---|
| タスク追加 | テキスト入力→Haikuで期日自動抽出 |
| タスク編集 | インライン編集（タイトル・期日） |
| タスク完了 | ワンクリック完了 |
| タスク削除 | ワンクリック削除 |
| 完了済み表示 | 折りたたみで最大10件表示 |

## 8. メール分類ロジック

### Phase 1: ルールベース（newsletter即確定）

| シグナル | 判定 |
|---|---|
| List-Unsubscribe / List-Id ヘッダー | newsletter |
| Precedence: bulk/list/junk | newsletter |
| From: no-reply/newsletter/marketing等 | newsletter |
| To/CCに自分のアドレスなし（BCC配信） | newsletter |
| 本文冒頭300字に「配信停止」「unsubscribe」 | newsletter |
| プロモ件名 + 企業ドメイン | newsletter |

### Phase 2: キーワード即確定

| シグナル | 判定 |
|---|---|
| 件名/本文に「至急」「ASAP」「緊急」 | urgent_reply |
| 件名に「ご確認ください」「いかがでしょうか」 | reply_later |

### Phase 3: Haiku 4択分類

| カテゴリ | 説明 |
|---|---|
| newsletter | メルマガ・広告・自動通知 |
| reply_later | 返信が必要（数日以内） |
| action_needed | 行動が必要（締切・依頼等） |
| fyi | 読むだけでOK |

### キャッシュ

- `email_cache`テーブルに分類結果を保存
- 7日間有効（`cached_at >= datetime('now', '-7 days', 'localtime')`）
- `classifyEmailWithCache()`でキャッシュスルー

## 9. Google OAuth情報

| 項目 | 詳細 |
|---|---|
| プロジェクト | mitsumori-maker |
| スコープ | gmail.readonly, gmail.send, calendar, userinfo.email |
| ステータス | テスト段階（テストユーザー手動追加が必要） |
| コールバックURL | {BASE_URL}/auth/callback |
| トークン保存先 | google_accountsテーブル |
| リフレッシュ | 期限60秒前に自動実行 |
| LINE内ブラウザ対策 | /auth/startでURLコピー画面を表示 |

## 10. αテスト運用フロー

```
1. ユーザーがLINE友達追加
   → 6通のウェルカムメッセージ（Flex Message）
   → users テーブルに plan=trial で登録

2. Google Console でテストユーザー追加（手動）

3. ユーザーが /auth/start?user=XX のURLをコピー
   → SafariでGoogle OAuth完了
   → google_accounts に保存
   → LINEに「連携完了」通知

4. ユーザーがLINEで話しかける
   → SimpleCommand or AI対話
   → ブリーフィングが自動配信開始
```

## 11. ファイル構成

```
src/
├── server.ts              # エントリーポイント・ルート登録
├── types.ts               # Email, CalendarEvent, User等の型定義
│
├── handlers/
│   └── webhook.ts         # LINE Webhook・followイベント・メッセージ処理
│
├── agents/
│   ├── secretary.ts       # メインエージェント（SimpleCommand/Light/Pro）
│   ├── classifier.ts      # メール分類（2フェーズ+キャッシュ）
│   ├── briefing.ts        # 朝昼夜ブリーフィング生成
│   ├── reply.ts           # 返信案生成（Sonnet）
│   ├── style-learner.ts   # 文体学習
│   └── calendar-parser.ts # 日時パーサー
│
├── integrations/
│   ├── gmail.ts           # Gmail API（getUnread/getRecent/getAll/getSent/getThread/sendReply/checkThreadReplied）
│   ├── gcal.ts            # Google Calendar API（getToday/getTomorrow/getWeek/getMonth/createEvent）
│   ├── auth.ts            # Google OAuth2（/auth/start, /auth/callback, getAuthedClient）
│   ├── weather.ts         # OpenWeatherMap API
│   └── errors.ts          # GoogleApiError
│
├── routes/
│   └── dashboard.ts       # Webダッシュボード（メール処理・タスク管理）
│
├── cron/
│   ├── morning.ts         # ブリーフィングcron（8:00/12:00/21:00）
│   └── auto-draft.ts      # 移動リマインドcron（5分おき）
│
├── db/
│   ├── schema.sql         # テーブル定義
│   └── queries.ts         # DB操作関数・使用量管理
│
└── utils/
    └── usage.ts           # 使用量アラート通知
```
