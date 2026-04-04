import Anthropic from "@anthropic-ai/sdk";
import { getSentEmails } from "../integrations/gmail.js";
import { updateWritingStyle } from "../db/queries.js";

const isDev = process.env["NODE_ENV"] === "development";

const STYLE_ANALYSIS_PROMPT = `あなたはメールの文体を分析するアシスタントです。
以下の送信済みメールを分析し、ユーザーの文体の特徴を簡潔にまとめてください。

## 分析項目
- フォーマル度（敬語の程度）
- よく使う挨拶・結びの言葉
- よく使うフレーズ・言い回し
- トーン（丁寧・カジュアル・ビジネスライクなど）

## ルール
- 300文字以内で簡潔にまとめる
- 箇条書きではなく、プロンプトとして使える自然な文章で書く
- 「この人は〜」という形式で記述する`;

export async function learnStyle(userId: string): Promise<string> {
  if (isDev) {
    console.log("[DEV] 文体学習: モックモード");
    const mockStyle =
      "この人は丁寧なビジネス文体を使い、「お世話になっております」で始め「よろしくお願いいたします」で締める。敬語を正確に使い、簡潔で要点を押さえた文章を好む。";
    updateWritingStyle(userId, mockStyle);
    return mockStyle;
  }

  const sentEmails = await getSentEmails(userId, 10);

  if (sentEmails.length === 0) {
    const fallback = "送信済みメールが見つからないため、標準的なビジネス文体を使用します。";
    updateWritingStyle(userId, fallback);
    return fallback;
  }

  const emailTexts = sentEmails
    .map((e, i) => `--- メール${i + 1} ---\nTo: ${e.to}\nSubject: ${e.subject}\n\n${e.body}`)
    .join("\n\n");

  const client = new Anthropic();
  const message = await client.messages.create({
    model: "claude-haiku-4-5-20251001",
    max_tokens: 512,
    system: STYLE_ANALYSIS_PROMPT,
    messages: [
      {
        role: "user",
        content: `以下の送信済みメールから文体を分析してください。\n\n${emailTexts}`,
      },
    ],
  });

  const block = message.content[0];
  if (!block || block.type !== "text") {
    throw new Error("Unexpected response type from Claude");
  }

  const style = block.text.slice(0, 300);
  updateWritingStyle(userId, style);
  return style;
}
