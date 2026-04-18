# AI秘書 設計ドキュメント

## 1. システム概要・設計原則

LINEをUIとしたAI秘書サービス。Gmail・Google Calendarと連携し、ブリーフィング・メール返信支援・自由対話を提供する。

### 設計原則

1. **LINE応答3秒ルール** — 重い処理の前に「確認中...」を即返却
2. **コスト最適化** — 定型コマンドはAI不使用（無料）、分類はHaiku（安価）、対話はSonnet（高精度）
3. **キャッシュ優先** — メール分類は7日間キャッシュし、同じメールの再分類を防止
4. **オンデマンド処理** — 5分cronでのメール分類を廃止し、表示時に都度分類（キャッシュ付き）
5. **全プランSimpleCommand無料** — 予定確認・タスク・メール一覧はクレジット消費なし

## 2. アーキテクチャ図

```
┌─────────────┐     ┌──────────────────────────────────────────┐
│  LINE App   │────▶│  Hono Server (Railway)                   │
│  (ユーザー) │◀────│                                          │
└─────────────┘     │  /webhook ─▶ handleMessage               │
                    │    ├─ SimpleCommand (無料)                │
                    │    ├─ lightPlanProcessor (Light)          │
                    │    └─ proAgentLoop (Trial/Pro, Sonnet)    │
                    │                                          │
                    │  /dashboard ─▶ メール処理UI               │
                    │  /dashboard/tasks ─▶ タスク管理UI         │
                    │  /auth/start ─▶ Google OAuth              │
                    │  /reply ─▶ 返信確認・送信                 │
                    │                                          │
                    │  Cron:                                    │
                    │    8:00  朝ブリーフィング (Haiku)          │
                    │    12:00 昼ブリーフィング (ルールベース)   │
                    │    21:00 夜ブリーフィング (ルールベース)   │
                    │    */5   移動リマインド                    │
                    └──────────┬───────────────────────────────┘
                               │
              ┌────────────────┼────────────────┐
              ▼                ▼                ▼
        ┌──────────┐   ┌────────────┐   ┌─────────────┐
        │ SQLite   │   │ Gmail API  │   │ Claude API  │
        │ (WAL)    │   │ GCal API   │   │ Haiku/Sonnet│
        └──────────┘   └────────────┘   └─────────────┘
```

## 3. 主要設計決定（ADR）

### ADR-001: メール分類をオンデマンド+キャッシュ方式に変更

- **決定日**: 2026-04-06
- **背景**: 5分おきのcronでメール分類していたが、未連携ユーザーでのエラー・不要なAPI呼び出しが多かった
- **決定**: ブリーフィング時・ダッシュボード表示時に都度分類し、`email_cache`テーブルに7日間キャッシュ
- **結果**: Haiku呼び出し回数が大幅削減。cronはメール分類を完全廃止し移動リマインドのみ

### ADR-002: SimpleCommandを全プラン無料化

- **決定日**: 2026-04-06
- **背景**: Light/Trial/Proで処理フローが異なり複雑だった
- **決定**: `matchSimpleCommand`を全プランで最初に実行。マッチした場合はSonnet不使用で即レスポンス
- **結果**: Light/TrialでもSchedule/Task/Email確認が無料で使え、UXが統一された

### ADR-003: クレジット制への統一

- **決定日**: 2026-04-06
- **背景**: `ai_reply`と`conversation`の2種類の使用量管理が複雑だった
- **決定**: `credit`に統一。Trial=30, Light=100, Pro=300クレジット/月
- **結果**: ユーザーにとってもわかりやすく、管理コードもシンプルに

### ADR-004: ダッシュボード（Web UI）の導入

- **決定日**: 2026-04-05
- **背景**: LINEだけではメール返信の編集・確認が困難
- **決定**: `/dashboard`と`/dashboard/tasks`のWeb UIを追加。認証は`?token=userId`
- **結果**: メール返信の編集・送信・タスク管理をブラウザで操作可能に

### ADR-005: メール返信生成にSonnet+カレンダー統合

- **決定日**: 2026-04-06
- **背景**: Haikuでの返信案は品質が不十分だった
- **決定**: ダッシュボードの返信生成はSonnet使用。日程調整メールを検知したらカレンダー空き情報を付加
- **結果**: 日程調整メールに具体的な候補日時を含む返信が生成可能に

### ADR-006: 複数Googleアカウント対応

- **決定日**: 2026-04-04
- **背景**: ユーザーが仕事用・個人用の複数Gmailを持つケースが多い
- **決定**: `google_accounts`テーブルで複数アカウント管理。全アカウントから`Promise.allSettled`で並行取得しマージ
- **結果**: メール・カレンダーが統合表示される。送信はスレッド所属アカウントを自動検出

### ADR-007: メールからのタスク自動抽出を廃止

- **決定日**: 2026-04-06
- **背景**: LLMによるタスク抽出の精度が低く、不要なタスクが多数作成されていた
- **決定**: `extractTasksFromEmail`を完全削除。タスクはLINEまたはダッシュボードから手動追加のみ
- **結果**: ノイズが減り、タスクリストの信頼性が向上

### ADR-008: lightPlanProcessorを廃止し全プランSonnet統一

- **決定日**: 2026-04-06
- **背景**: クレジット制移行により機能ベースのプラン分けが不要になった。lightPlanProcessorはSimpleCommand処理後の残りパターンのみで、ほぼ空だった
- **決定**: lightPlanProcessorを完全削除。全プランで`proAgentLoop`（Sonnet）を使用。クレジット上限はproAgentLoop内でチェック
- **結果**: ユーザーはクレジットの範囲内で全機能を使える。コードも大幅に簡素化

### ADR-009: getMonthlyUsageのタイムゾーン統一

- **決定日**: 2026-04-06
- **背景**: usage_logsのcreated_atはlocaltime保存だが、月初計算が`toISOString()`（UTC）だったため時差で誤カウントする可能性があった
- **決定**: SQLite側で`date('now', 'start of month', 'localtime')`を使って統一
- **結果**: JSとSQLiteのタイムゾーン不一致による誤カウントを解消

### ADR-010: クレジットアラートを2段階に変更

- **決定日**: 2026-04-06
- **背景**: 80%到達時の通知だけだと、その1回を取りこぼした場合に永遠に通知されない
- **決定**: 段階1（ちょうど80%超えた瞬間）＋段階2（残り3以下になった時点）の2段階アラートに変更
- **結果**: アラート漏れのリスクが減少。ユーザーは上限到達前に必ず気づける

### ADR-011: メール分類をHaikuからルールベースに完全移行

- **決定日**: 2026-04-07
- **背景**: Haikuがビジネスメールをfyiやnewsletterに誤分類することが多く、要返信メールが表示されない問題が続発した
- **決定**: Haiku分類を廃止。ルールベース（no-reply/List-Unsubscribeヘッダー等）で自動送信を除外し、残り全てを要返信候補として表示する
- **理由**: 「返信要否」の判断は文脈・関係性に依存するため、LLMでの自動判断より人間が判断する方が確実
- **追加機能**: 件名・本文のキーワードでラベル付与（日程調整/質問/依頼/急ぎ）してユーザーの優先度判断を補助する
- **結果**: 要返信メールの取りこぼしが解消。ダッシュボード表示速度も向上（Haiku API呼び出しなし）

### ADR-012: 移動リマインド通知済み記録をDBに移行

- **決定日**: 2026-04-07
- **背景**: メモリのSetで管理していたため、デプロイ・再起動のたびにリセットされ重複通知のリスクがあった
- **決定**: usage_logsテーブルに`action_type = "move_reminder:{eventId}"`として記録
- **理由**: 既存のusage_logsテーブルを再利用できるため新テーブル不要
- **結果**: 再起動しても同日中の重複通知を防止

## 4. メール処理フロー

### 要返信判定フロー

```
受信メール
  │
  ├─ Phase 1: ルールベース（newsletter判定）
  │   ├─ List-Unsubscribe/List-Id → newsletter
  │   ├─ Precedence: bulk/list → newsletter
  │   ├─ From: no-reply等 → newsletter
  │   ├─ To/CCに自分なし → newsletter
  │   ├─ 本文に配信停止 → newsletter
  │   └─ プロモ件名+企業ドメイン → newsletter
  │
  ├─ urgent検知: 至急/ASAP/緊急 → urgent_reply
  │
  ├─ reply_later事前判定: ご確認ください等 → reply_later
  │
  └─ Phase 2: Haiku 4択分類
      ├─ newsletter
      ├─ reply_later
      ├─ action_needed
      └─ fyi
```

### 送信フロー

```
返信案生成（Sonnet）
  → pending_replies テーブルに保存
  → /reply?id=X ページで確認
  → 編集可能（textarea切り替え）
  → 送信 → sendReply() → Gmail API
  → pending_replies.status = 'sent'
```

## 5. AIモデル使い分け

| 用途 | モデル | コスト | 備考 |
|---|---|---|---|
| メール分類 | claude-haiku-4-5-20251001 | 無料 | email_cacheで7日キャッシュ |
| ブリーフィング（朝） | claude-haiku-4-5-20251001 | 無料 | ルールベースにフォールバック |
| ブリーフィング（昼・夜） | なし（ルールベース） | 無料 | |
| メモ→清書 | claude-haiku-4-5-20251001 | 1 credit | polish-reply |
| タスク期日抽出 | claude-haiku-4-5-20251001 | 無料 | ダッシュボードのタスク追加時 |
| 返信案生成 | claude-sonnet-4-6 | 1 credit | カレンダー統合あり |
| フォローアップ生成 | claude-sonnet-4-6 | 1 credit | 催促を避ける表現 |
| AI自由対話 | claude-sonnet-4-6 | 1 credit | Tool Use対応 |
| 意図分類 | claude-haiku-4-5-20251001 | 無料 | dev時はregexフォールバック |

## 6. SimpleCommand一覧

| パターン | コマンド | 処理内容 |
|---|---|---|
| 今日の予定/今日どんな | today_schedule | getTodayEvents → 一覧表示 |
| 今週の予定/週間 | week_schedule | getWeekEvents → 日別グループ表示 |
| 今月の予定 | month_schedule | getMonthEvents → 日別グループ表示（最大10件） |
| 空いてる/空き時間 | free_time | getWeekEvents → 平日9-19時の空き計算 |
| 未読/メール来てる | unread_email | getUnreadEmails → 一覧表示 |
| 返信すべき/要返信 | dashboard | ダッシュボードURL案内 |
| ○○をタスクに | task_add | createTask → タスクURL案内 |
| タスク完了 | task_done | updateTaskStatus → 完了 |
| タスク/やること | task_list | getTasks → 一覧+タスクURL |
| 保留/保留メール | hold_list | getPendingRepliesByStatus → 一覧 |
| ダッシュボード/メール処理 | dashboard | メール+タスクURL案内 |

## 7. Cronスケジュール

| 時間 | 処理 | ファイル |
|---|---|---|
| 毎朝 8:00 | 朝ブリーフィング（Haiku） | morning.ts |
| 毎日 12:00 | 昼ブリーフィング（ルールベース） | morning.ts |
| 毎日 21:00 | 夜ブリーフィング（ルールベース） | morning.ts |
| 5分おき | 移動リマインド（場所付き予定の1時間前） | auto-draft.ts |

## 8. DBテーブル一覧

| テーブル | 用途 |
|---|---|
| users | ユーザー情報・プラン・トークン |
| google_accounts | 複数Googleアカウント管理 |
| conversations | 会話履歴 |
| processed_emails | メール分類結果（レガシー・新規書き込みなし） |
| email_cache | メール分類キャッシュ（7日TTL） |
| pending_replies | 返信案の保存・ステータス管理 |
| tasks | タスク管理 |
| usage_logs | クレジット使用量ログ |

## 9. パフォーマンス最適化

- **email_cache**: 同一メールの分類を7日間キャッシュ（Haiku呼び出し削減）
- **メルマガFrom早期除外**: Haiku呼び出し前にno-reply等のパターンで除外
- **件数上限**: 要返信10件、返信待ち5件、昼夜カウント5件でbreak
- **90日上限**: 返信待ちメールは90日以上前を除外
- **Promise.allSettled**: 複数Googleアカウントの並行取得
- **SQLite WAL**: 読み書き並行処理
- **SimpleCommand最優先**: 全プランでAI不使用の定型処理を先に実行

## 10. セキュリティ

- **OAuth2**: パスワード不保存、Gmail/Calendar/UserInfoスコープのみ
- **トークン管理**: DBに暗号化なしで保存（Railway永続ボリューム）、期限前にauto-refresh
- **ダッシュボード認証**: `?token=userId`パラメータ（LINE UserIDをトークンとして使用）
- **LINE Webhook**: `x-line-signature`ヘッダーで検証
- **Admin API**: `x-admin-secret`ヘッダーで認証

## 11. 既知の問題・TODO

- [ ] ダッシュボード認証をJWTまたはセッションベースに強化
- [ ] processed_emailsテーブルの廃止（email_cacheに完全移行後）
- [ ] 決済機能の実装（Stripe等）
- [ ] Pro超過分の従量課金
- [ ] getAllEmails の scope="all" 実装（現在はgetUnreadEmailsで代替）
- [x] Google OAuth「テストユーザー」制限の解除（本番公開申請）※2026-04-18 審査申請済み
- [ ] ブリーフィング時間のユーザー別カスタマイズ
- [ ] カレンダー予定作成の複数アカウント選択
