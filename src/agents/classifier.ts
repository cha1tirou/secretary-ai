import Anthropic from "@anthropic-ai/sdk";
import type { Email } from "../types.js";
import type { EmailCategory } from "../db/queries.js";

const isDev = process.env["NODE_ENV"] === "development";

// ── Intent分類 ──

export type Intent =
  | "calendar_read"
  | "email_read"
  | "email_reply"
  | "email_search"
  | "calendar_create"
  | "briefing"
  | "style_learn"
  | "pending_review"
  | "hold_list"
  | "task_list"
  | "task_done"
  | "task_add"
  | "schedule_check"
  | "week_schedule"
  | "small_talk"
  | "unknown";

export type ClassifyResult = {
  intent: Intent;
  params: Record<string, string>;
};

const VALID_INTENTS: Intent[] = [
  "calendar_read", "email_read", "email_reply", "email_search",
  "calendar_create", "briefing", "style_learn", "pending_review", "hold_list",
  "task_list", "task_done", "task_add", "schedule_check", "week_schedule",
  "small_talk", "unknown",
];

function classifyByRegex(text: string): ClassifyResult {
  // タスク系（順序重要：task_addはtask_listより先に）
  if (/タスク.*追加|追加.*タスク|やること.*追加/.test(text)) {
    return { intent: "task_add", params: { raw: text } };
  }
  if (/完了|終わった|やった|済み/.test(text) && /タスク|やること/.test(text)) {
    return { intent: "task_done", params: { raw: text } };
  }
  if (/タスク|やること|todo/i.test(text)) {
    return { intent: "task_list", params: {} };
  }
  // スケジュール系
  if (/空いてる|空き時間|いつ空い/.test(text)) {
    return { intent: "schedule_check", params: { raw: text } };
  }
  if (/今週の予定|今週どんな/.test(text)) {
    return { intent: "week_schedule", params: {} };
  }
  // 予定
  if (/予定|カレンダー|スケジュール/.test(text)) {
    if (/登録|追加|入れて|作って|セット/.test(text)) {
      return { intent: "calendar_create", params: { raw: text } };
    }
    return { intent: "calendar_read", params: {} };
  }
  // メール系
  if (/探して.*メール|メール.*探して|から.*メール.*来てる|メール.*検索/.test(text)) {
    return { intent: "email_search", params: { raw: text } };
  }
  if (/メール|未読|inbox/i.test(text)) {
    return { intent: "email_read", params: {} };
  }
  if (/返信|返して|リプライ/i.test(text)) {
    return { intent: "email_reply", params: { raw: text } };
  }
  // 保留
  if (/保留.*メール|保留.*確認|保留.*見せて|保留一覧|保留してた/.test(text)) {
    return { intent: "hold_list", params: {} };
  }
  // その他
  if (/ブリーフィング|朝の報告|今日のまとめ/.test(text)) {
    return { intent: "briefing", params: {} };
  }
  if (/文体学習|文体を学習|スタイル学習|書き方を覚えて/.test(text)) {
    return { intent: "style_learn", params: {} };
  }
  if (/ありがとう|おはよう|こんにちは|こんばんは|了解|OK|おつかれ/i.test(text)) {
    return { intent: "small_talk", params: {} };
  }
  return { intent: "unknown", params: {} };
}

const INTENT_SYSTEM_PROMPT = `あなたはユーザーの意図を分類するアシスタントです。
以下のintentから最も適切なものを1つ選んでください。

- calendar_read: 今日の予定の確認・表示
- week_schedule: 今週の予定を確認
- schedule_check: 空き時間の確認
- email_read: メールの確認・未読一覧
- email_reply: 特定のメールへの返信を依頼
- email_search: 特定のメールを検索（人名・キーワード指定）
- calendar_create: 予定の登録・追加
- briefing: 朝のブリーフィングを要求
- style_learn: メールの文体・書き方を学習してほしい
- pending_review: 保留中・未対応のメール返信案を確認したい
- hold_list: 保留中のメール一覧を見たい
- task_list: タスク一覧を確認したい
- task_done: タスクを完了にしたい
- task_add: タスクを追加したい
- small_talk: 挨拶・雑談・お礼
- unknown: 上記に当てはまらない

JSON形式で回答してください:
{"intent": "...", "params": {"key": "value"}}

paramsには以下を含めてください（該当する場合のみ）:
- email_reply: {"raw": "元のテキスト"}
- email_search: {"query": "検索キーワード"}
- calendar_create: {"title": "予定名", "date": "日付", "time": "時間", "raw": "元のテキスト"}
- task_add: {"title": "タスク名", "raw": "元のテキスト"}
- task_done: {"raw": "元のテキスト"}
- schedule_check: {"raw": "元のテキスト"}
- それ以外: {}`;

export async function classifyIntent(text: string): Promise<ClassifyResult> {
  if (isDev) {
    console.log("[DEV] 意図解釈: regexモード");
    return classifyByRegex(text);
  }

  try {
    const client = new Anthropic();
    const message = await client.messages.create({
      model: "claude-haiku-4-5-20251001",
      max_tokens: 256,
      system: INTENT_SYSTEM_PROMPT,
      messages: [{ role: "user", content: text }],
    });

    const block = message.content[0];
    if (!block || block.type !== "text") {
      return classifyByRegex(text);
    }

    const parsed = JSON.parse(block.text) as ClassifyResult;
    if (!VALID_INTENTS.includes(parsed.intent)) {
      return classifyByRegex(text);
    }
    return parsed;
  } catch (err) {
    console.error("[classifier] LLM分類エラー、regexにフォールバック:", err);
    return classifyByRegex(text);
  }
}

// ── メール分類（2フェーズ） ──

const NEWSLETTER_FROM_PATTERNS = /no-?reply|noreply|newsletter|notifications?|donotreply|marketing|promo|promotions?|updates?|automated|system@|auto@|info@/i;
const URGENT_KEYWORDS = /至急|ASAP|本日中|今日中|緊急|urgent/i;
const UNSUBSCRIBE_PATTERNS = /配信停止|購読解除|受信拒否|unsubscribe|opt.?out|メール配信を停止|このメールの配信を/i;
const PROMO_SUBJECT = /\d+%オフ|\d+%OFF|割引クーポン|セール|キャンペーン|期間限定|特別価格/i;
const CORP_FROM = /[@.](com|co\.jp|net|org)/i;
const REPLY_NEEDED_SUBJECT = /ご確認ください|ご返信ください|お返事|返信をお願い|教えてください|いかがでしょうか/;

const VALID_PERSONAL_CATEGORIES: EmailCategory[] = [
  "newsletter", "reply_later", "action_needed", "fyi",
];

/**
 * フェーズ1: ルールベースのメルマガ判定
 */
function detectNewsletter(email: Email, userEmail?: string): boolean {
  // List-Unsubscribe / List-Id ヘッダーの存在
  if (email.listUnsubscribe || email.listId) return true;

  // Precedence ヘッダー
  if (email.precedence && /bulk|list|junk/i.test(email.precedence)) return true;

  // From に自動送信パターンを含む
  if (NEWSLETTER_FROM_PATTERNS.test(email.from)) return true;

  // To/CC に自分のアドレスが含まれない（BCC配信 = メルマガ）
  if (userEmail) {
    const addr = userEmail.toLowerCase();
    const recipients = (email.to + " " + email.cc).toLowerCase();
    if (!recipients.includes(addr)) return true;
  }

  // 本文の冒頭に配信停止パターン
  if (UNSUBSCRIBE_PATTERNS.test(email.body.slice(0, 300))) return true;

  // 件名がプロモーション系 + 送信者が企業ドメイン
  if (PROMO_SUBJECT.test(email.subject) && CORP_FROM.test(email.from)) return true;

  return false;
}

/**
 * urgent キーワード検出（件名・本文）
 */
function detectUrgent(email: Email): boolean {
  return URGENT_KEYWORDS.test(email.subject + " " + email.body);
}

/**
 * フェーズ2用の regex フォールバック（開発モード or LLM失敗時）
 */
function classifyPersonalByRegex(email: Email): EmailCategory {
  const text = email.subject + " " + email.body;
  if (/ご確認|ご返信|ご回答|お返事|教えてください|ご連絡ください|please reply|please respond/i.test(text)) {
    return "reply_later";
  }
  if (/してください|をお願い|期日|締め切り|締切|deadline|提出/i.test(text)) {
    return "action_needed";
  }
  return "fyi";
}

const PERSONAL_EMAIL_SYSTEM_PROMPT = `あなたはメールを分類するアシスタントです。
以下の4カテゴリから最も適切なものを1つ選んでください。

- newsletter: メルマガ・広告・自動通知・サービスからの一斉配信・定期配信
- reply_later: 個人からのメールで返信が必要（数日以内でOK）
- action_needed: 返信不要だが自分の行動が必要（締切・資料提出・確認等）
- fyi: 個人からのメールで読むだけでOK・返信不要

判断のポイント：
- 「配信停止」「unsubscribe」があればnewsletter
- 特定の個人に向けた内容でなければnewsletter
- 質問・依頼・日程調整・確認依頼はreply_later
- お知らせ・領収書・自動送信はnewsletter

JSON形式で回答: {"category": "..."}`;

/**
 * メール分類メイン関数
 * フェーズ1（ルールベース）→ フェーズ2（Haiku 4択）の2段構成
 */
export async function classifyEmail(email: Email, userEmail?: string): Promise<EmailCategory> {
  // フェーズ1: メルマガ判定
  if (detectNewsletter(email, userEmail)) {
    return "newsletter";
  }

  // urgent キーワード検出
  if (detectUrgent(email)) {
    return "urgent_reply";
  }

  // 件名で明確にreply_laterと判断できるケース（Haiku不要・コスト節約）
  if (REPLY_NEEDED_SUBJECT.test(email.subject)) {
    return "reply_later";
  }

  // フェーズ2: Haiku 4択分類
  if (isDev) {
    return classifyPersonalByRegex(email);
  }

  try {
    const client = new Anthropic();
    const message = await client.messages.create({
      model: "claude-haiku-4-5-20251001",
      max_tokens: 128,
      system: PERSONAL_EMAIL_SYSTEM_PROMPT,
      messages: [{
        role: "user",
        content: `From: ${email.from}\nSubject: ${email.subject}\n\n${email.body.slice(0, 300)}`,
      }],
    });

    const block = message.content[0];
    if (!block || block.type !== "text") return classifyPersonalByRegex(email);

    const parsed = JSON.parse(block.text) as { category: EmailCategory };
    if (!VALID_PERSONAL_CATEGORIES.includes(parsed.category)) return classifyPersonalByRegex(email);
    return parsed.category;
  } catch (err) {
    console.error("[classifier] メール分類LLMエラー:", err);
    return classifyPersonalByRegex(email);
  }
}

// ── メールからタスク抽出 ──

export type ExtractedTask = { title: string; dueDate?: string };

function extractTasksByRegex(email: Email): ExtractedTask[] {
  const tasks: ExtractedTask[] = [];
  const text = email.subject + " " + email.body;

  // 「〜してください」「〜をお願い」パターン
  const patterns = [
    /(.{5,30}?)(?:してください|をお願い|して頂|していただ|お願いいたし)/g,
    /(?:期日|締め切り|締切|deadline)[：:\s]*(\d{1,2}[\/月]\d{1,2}[日]?)/gi,
  ];

  for (const match of text.matchAll(patterns[0]!)) {
    const title = (match[1] ?? "").replace(/^[、。\s]+/, "").trim();
    if (title.length >= 3) {
      tasks.push({ title });
    }
  }

  // 期日検出
  let dueDate: string | undefined;
  for (const match of text.matchAll(patterns[1]!)) {
    dueDate = (match[1] ?? "").trim();
  }
  if (dueDate && tasks.length > 0 && tasks[0]) {
    tasks[0].dueDate = dueDate;
  }

  return tasks.slice(0, 3);
}

const TASK_EXTRACT_PROMPT = `メールからタスク（やるべきこと）を抽出してください。
依頼・要求・期限のある項目を探してください。
JSON配列で回答: [{"title": "タスク名（20文字以内）", "dueDate": "YYYY-MM-DD or null"}]
タスクがなければ空配列 [] を返してください。最大3件まで。`;

export async function extractTasksFromEmail(email: Email): Promise<ExtractedTask[]> {
  if (isDev) {
    return extractTasksByRegex(email);
  }

  try {
    const client = new Anthropic();
    const message = await client.messages.create({
      model: "claude-haiku-4-5-20251001",
      max_tokens: 256,
      system: TASK_EXTRACT_PROMPT,
      messages: [{
        role: "user",
        content: `From: ${email.from}\nSubject: ${email.subject}\n\n${email.body.slice(0, 500)}`,
      }],
    });

    const block = message.content[0];
    if (!block || block.type !== "text") return extractTasksByRegex(email);

    const parsed = JSON.parse(block.text) as ExtractedTask[];
    return Array.isArray(parsed) ? parsed.slice(0, 3) : [];
  } catch (err) {
    console.error("[classifier] タスク抽出LLMエラー:", err);
    return extractTasksByRegex(email);
  }
}
