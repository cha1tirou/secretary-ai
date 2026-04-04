import Anthropic from "@anthropic-ai/sdk";
import type { Email } from "../types.js";
import { getUser } from "../db/queries.js";

const isDev = process.env["NODE_ENV"] === "development";

const BASE_SYSTEM_PROMPT = `あなたはユーザーの代わりにメール返信を作成するAI秘書です。

## ルール
- ビジネスメールとして適切な文体
- 簡潔で要点を押さえた返信
- 宛名・署名は含めない（本文のみ）
- 日本語で返信（元のメールが英語でも）`;

export async function generateReply(thread: Email[], userId?: string): Promise<string> {
  const threadText = thread
    .map((m) => `From: ${m.from}\nDate: ${m.date}\nSubject: ${m.subject}\n\n${m.body}`)
    .join("\n---\n");

  if (isDev) {
    console.log("[DEV] 返信生成: モックモード");
    const last = thread[thread.length - 1];
    return `ご連絡ありがとうございます。\n${last?.subject ?? ""}の件、承知いたしました。\n確認の上、改めてご連絡いたします。`;
  }

  let systemPrompt = BASE_SYSTEM_PROMPT;
  if (userId) {
    const user = getUser(userId);
    if (user?.writingStyle) {
      systemPrompt += `\n\n## ユーザーの文体\n以下の文体に合わせて返信を作成してください:\n${user.writingStyle}`;
    }
  }

  const client = new Anthropic();
  const message = await client.messages.create({
    model: "claude-sonnet-4-5-20250514",
    max_tokens: 1024,
    system: systemPrompt,
    messages: [
      {
        role: "user",
        content: `以下のメールスレッドに対する返信を作成してください。\n\n${threadText}`,
      },
    ],
  });

  const block = message.content[0];
  if (!block || block.type !== "text") {
    throw new Error("Unexpected response type from Claude");
  }
  return block.text;
}
