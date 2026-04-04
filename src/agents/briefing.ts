import Anthropic from "@anthropic-ai/sdk";
import { getTodayEvents } from "../integrations/gcal.js";
import { getUnreadEmails } from "../integrations/gmail.js";
import { countProcessedEmailsByCategory, getProcessedEmailsByCategory, getDb } from "../db/queries.js";
import type { CalendarEvent, Email } from "../types.js";

const isDev = process.env["NODE_ENV"] === "development";

type BriefingContext = {
  events: CalendarEvent[];
  emails: Email[];
  importantInfoSubjects: string[];
  newsletterCount: number;
};

function buildPrompt(ctx: BriefingContext): string {
  const { events, emails, importantInfoSubjects, newsletterCount } = ctx;
  const eventSection =
    events.length === 0
      ? "今日の予定はありません。"
      : events
          .map((e) => {
            const start = e.start.includes("T")
              ? new Date(e.start).toLocaleTimeString("ja-JP", { hour: "2-digit", minute: "2-digit" })
              : "終日";
            const end = e.end.includes("T")
              ? new Date(e.end).toLocaleTimeString("ja-JP", { hour: "2-digit", minute: "2-digit" })
              : "";
            const loc = e.location ? ` (${e.location})` : "";
            return `- ${start}${end ? `〜${end}` : ""} ${e.summary}${loc}`;
          })
          .join("\n");

  const emailSection =
    emails.length === 0
      ? "未読メールはありません。"
      : emails
          .map((e) => `- From: ${e.from}\n  件名: ${e.subject}\n  概要: ${e.body.slice(0, 200)}`)
          .join("\n");

  return `あなたはLINEで動くAI秘書です。以下の情報をもとに、朝のブリーフィングメッセージを作成してください。

## ルール
- LINEで読みやすい簡潔な形式にする
- 予定は時系列順に箇条書き
- メールは重要度が高そうなものから要約する
- 全体で1000文字以内に収める
- 絵文字は控えめに使う

## 今日の予定
${eventSection}

## 未読メール (${emails.length}件)
${emailSection}

## 重要なお知らせ (${importantInfoSubjects.length}件)
${importantInfoSubjects.length === 0 ? "なし" : importantInfoSubjects.map((s) => `- ${s}`).join("\n")}

## メルマガ・広告
${newsletterCount}件`;
}

function mockBriefing(ctx: BriefingContext): string {
  const { events, emails, importantInfoSubjects, newsletterCount } = ctx;
  const date = new Date().toLocaleDateString("ja-JP", {
    month: "long",
    day: "numeric",
    weekday: "short",
  });

  let text = `おはようございます。${date}のブリーフィングです。\n\n`;

  text += "【今日の予定】\n";
  if (events.length === 0) {
    text += "予定はありません。\n";
  } else {
    for (const e of events) {
      const start = e.start.includes("T")
        ? new Date(e.start).toLocaleTimeString("ja-JP", { hour: "2-digit", minute: "2-digit" })
        : "終日";
      text += `・${start} ${e.summary}\n`;
    }
  }

  text += `\n【未読メール ${emails.length}件】\n`;
  if (emails.length === 0) {
    text += "未読メールはありません。\n";
  } else {
    for (const e of emails.slice(0, 5)) {
      text += `・${(e.from.split("<")[0] ?? "").trim()}: ${e.subject}\n`;
    }
    if (emails.length > 5) {
      text += `…他${emails.length - 5}件\n`;
    }
  }

  if (importantInfoSubjects.length > 0) {
    text += `\n【お知らせ ${importantInfoSubjects.length}件】\n`;
    for (const s of importantInfoSubjects.slice(0, 3)) {
      text += `・${s}\n`;
    }
    if (importantInfoSubjects.length > 3) {
      text += `…他${importantInfoSubjects.length - 3}件\n`;
    }
  }

  if (newsletterCount > 0) {
    text += `\n【メルマガ ${newsletterCount}件】`;
  }

  return text.trim();
}

async function buildContext(userId: string): Promise<BriefingContext> {
  const [events, emails] = await Promise.all([
    getTodayEvents(userId),
    getUnreadEmails(userId),
  ]);

  // 今日のimportant_infoメールの件名一覧
  const todayStart = new Date();
  todayStart.setHours(0, 0, 0, 0);
  const importantRows = getProcessedEmailsByCategory(userId, "important_info", todayStart.toISOString());
  const importantInfoSubjects: string[] = [];
  for (const row of importantRows) {
    // processed_emailsにはsubjectがないので、未読メールから探す
    const match = emails.find((e) => e.id === row.messageId);
    if (match) importantInfoSubjects.push(match.subject);
  }

  const newsletterCount = countProcessedEmailsByCategory(userId, "newsletter", todayStart.toISOString());

  return { events, emails, importantInfoSubjects, newsletterCount };
}

export async function generateBriefing(userId: string): Promise<string> {
  const ctx = await buildContext(userId);

  if (isDev) {
    console.log("[DEV] LLMモック使用");
    return mockBriefing(ctx);
  }

  const client = new Anthropic();
  const message = await client.messages.create({
    model: "claude-haiku-4-5-20251001",
    max_tokens: 1024,
    messages: [
      {
        role: "user",
        content: buildPrompt(ctx),
      },
    ],
  });

  const block = message.content[0];
  if (!block || block.type !== "text") {
    throw new Error("Unexpected response type from Claude");
  }
  return block.text;
}

// ── 直接実行で動作確認 ──
if (process.argv[1]?.endsWith("briefing.ts")) {
  const { initDb } = await import("../db/queries.js");
  await import("dotenv/config");
  initDb();

  const userId = process.env["LINE_USER_ID"] || "default";
  console.log("=== ブリーフィング生成中... ===\n");
  const text = await generateBriefing(userId);
  console.log(text);
}
