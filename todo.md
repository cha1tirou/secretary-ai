# todo

## Week 1

- [x] src/types.ts に共通型定義を作る
      確認: TypeScriptエラーなくimportできる

- [x] src/db/queries.ts にSQLite操作関数を作る
      確認: npx tsx src/db/queries.ts でDBファイルが生成される

- [x] LINE Webhookでオウム返しが動く
      確認: Cloudflare TunnelのURLをLINE Developersに設定し
            LINEからメッセージを送ったら同じ内容が返ってくる

- [x] Google OAuth2認証フローが動く
      確認: http://localhost:3000/auth/startでGoogleログイン画面が出る
            ログイン後DBのusersにtokenが保存される

- [x] Gmail未読メール一覧が取れる
      確認: getUnreadEmails()で直近20通のJSONが返る

- [x] Google Calendar当日予定が取れる
      確認: getTodayEvents()で今日の予定JSONが返る

- [x] ブリーフィング文が生成できる
      確認: generateBriefing(events, emails)でLINE送信用テキストが返る

- [x] cron毎朝8時にブリーフィングがLINEに届く

## Week 2

- [x] 意図解釈が動く
- [x] Gmailスレッド全文が取れる
- [x] 返信文が生成できる
- [x] QuickReplyボタン付きで返信案をLINEに送れる
- [x] 送信ボタンを押したらメールが実際に届く
- [x] カレンダー登録ができる

## Week 3

- [ ] 毎日実業務で使う
- [x] レスポンス3秒超えるケースの修正
- [x] 文体学習の実装
- [x] メール分類システム (reply_urgent/reply_later/important_info/newsletter/other)
- [x] 自動ドラフト改修 (urgent即通知 + reply_later 10/15/19時まとめ)
- [x] ブリーフィングにお知らせ・メルマガ件数表示
- [x] QuickReplyに保留ボタン追加 + 保留一覧確認
- [x] tasksテーブル + CRUD (task_list/task_done/task_add)
- [x] メールからタスク自動抽出 (extractTasksFromEmail)
- [x] schedule_check (空き時間計算)
- [x] week_schedule (今週の予定を曜日別表示)
- [x] email_search (差出人・件名フィルタ)
- [x] hold_list (保留メール一覧)
- [x] secretary.ts ハイブリッドアーキテクチャ (regex simple_command + Sonnet Tool Use)
- [x] conversationsテーブル活用 (直近5件を会話コンテキストに)
- [x] webhook.ts をsecretary.ts委譲に大幅シンプル化
- [x] プラン設計 (trial/light/pro/expired)
- [x] lightPlanProcessor（定型コマンド処理）
- [x] followイベント（友達追加時のウェルカムメッセージ）
- [x] 体験残日数通知（ブリーフィング・応答末尾）
