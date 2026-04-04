# LINE AI秘書

## 概要
LINEで動くAI秘書。Gmail・Google Calendarと連携し、
朝のブリーフィング・メール返信提案・自由質問対応を行う。

## ディレクトリ構成
src/
  server.ts
  handlers/
  agents/
  integrations/
  db/
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

## 現在のタスク
todo.md を参照して上から順にこなす
