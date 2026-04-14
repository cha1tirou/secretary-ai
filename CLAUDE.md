# LINE AI秘書

## 概要
LINEで動くAI秘書。Gmail・Google Calendarと連携し、
朝のブリーフィング・メール返信提案・自由質問対応を行う。

## ディレクトリ構成
src/
  server.ts
  handlers/    (webhook, setup, commands, stripe, admin)
  agent/
  integrations/ (gmail, gcal, auth, stripe)
  db/
  cron/        (briefing, timer, emailWatch, reminders)
  policies/    (sendLimit)
  prompts/

## 技術スタック
- Hono + Node.js 20 + TypeScript
- better-sqlite3
- Claude API（Haiku: 分類/要約, Sonnet: 返信生成）
- LINE Messaging API
- Gmail API v1 / Google Calendar API v3

## 絶対に守るルール
1. LINE応答は3秒以内。重い処理の前に確認中メッセージを先に返す
2. Gmail送信はpending_repliesテーブルを必ず経由する
3. LLM呼び出しはsrc/agents/に集約する
4. OAuth2トークンはDBに保存し期限前にrefreshする
5. エラー時は必ずLINEでユーザーに通知する
6. NODE_ENV=developmentのときはLLMをモックで返す
7. Gmail送信の直前に `canSend()` で上限チェックし、成功後は必ず `recordSent()` で計上する（src/policies/sendLimit.ts）
8. LINE上のコマンドはスラッシュを付けず日本語キーワード（設定/プラン/解約/使用量/ステータス/領収書/プロモ XXXX）

## プラン・課金

### プラン構成（src/db/queries.ts SEND_LIMITS）
| plan | 月送信上限 | 価格 |
|------|----------|------|
| trial (OAuth後7日) | 150通 | ¥0 |
| free / expired | 5通 | ¥0 |
| lite | 30通 | ¥480 |
| standard | 60通 | ¥980 |
| pro | 150通 | ¥1,980 |

### ユーザー主導コマンド（webhook → commands.ts）
- 「プラン」→ Flex Carousel → 「プラン選択:Lite」等 → Stripe Checkout URL
- 「解約」→ Stripe Customer Portal URL（解約・カード変更・領収書DL）
- 「プロモ XXXX」→ プロモコード適用（期間付与、plan + plan_expires_at を更新）
- 「使用量」→ 今月の送信数・上限・リセットまでの日数
- 「ステータス」→ 現プラン・次回更新日・設定
- 「領収書」/「請求書」→ 直近5件の Stripe invoice PDF URL

### Stripe Webhook (/stripe/webhook)
- `checkout.session.completed` → customer / subscription ID を保存
- `customer.subscription.created/updated` → plan + plan_expires_at を更新、初回は LINE通知
- `customer.subscription.deleted` → plan=free、LINE通知
- `invoice.payment_failed` → plan=expired に即落とす、LINE通知（設計3A）

### プロモコード
- promo_codes テーブルで管理（/admin で発行・停止）
- ユーザーが redeem → user_promos に記録 + users.plan_expires_at 更新
- cron/reminders.ts が期限7日前・当日に通知、当日以降は free に戻す

### 通知タイミング（cron/reminders.ts, 毎朝 8:05）
- trial 4日目: 「あと3日」
- trial 6日目: 「明日で終了」
- trial 8日目: 「終了 → Free」＋ plan=free に更新
- プロモ終了7日前 / 当日

### 管理画面 (/admin)
- Basic 認証 (`ADMIN_PASSWORD`)
- プロモコード: 一覧・発行フォーム・停止
- ユーザー一覧（LINE ID・呼び名・email・plan・Stripe連携有無）

### 環境変数
`.env.example` 参照。Stripe 系と `ADMIN_PASSWORD` が未設定でもサーバは起動するが、該当コマンドは「準備中」応答になる。

### Stripe ダッシュボード設定
1. Product 3つ＋月額 JPY Price (480 / 980 / 1,980) を作成 → Price ID を `STRIPE_PRICE_*` に
2. Webhook 登録: `${APP_BASE_URL}/stripe/webhook`、イベントは上記4種
3. Customer Portal の機能で「領収書ダウンロード」「カード変更」「解約」を有効化

## 現在のタスク
todo.md を参照して上から順にこなす
