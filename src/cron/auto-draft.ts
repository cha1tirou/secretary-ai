import cron from "node-cron";
import { messagingApi, type QuickReplyItem } from "@line/bot-sdk";
import { getUnreadEmails, getThread } from "../integrations/gmail.js";
import { getTodayEvents } from "../integrations/gcal.js";
import { generateReply } from "../agents/reply.js";
import { classifyEmail, extractTasksFromEmail } from "../agents/classifier.js";
import {
  getDb,
  getAllUserIds,
  getGoogleAccountsByUserId,
  isEmailProcessed,
  markEmailProcessed,
  createPendingReply,
  createTask,
  type EmailCategory,
} from "../db/queries.js";
import type { Email } from "../types.js";

function getClient() {
  return new messagingApi.MessagingApiClient({
    channelAccessToken: process.env["LINE_CHANNEL_ACCESS_TOKEN"] || "",
  });
}

function makeQuickReply(pendingId: number): { items: QuickReplyItem[] } {
  return {
    items: [
      { type: "action", action: { type: "message", label: "\u9001\u4FE1", text: `\u9001\u4FE1 ${pendingId}` } },
      { type: "action", action: { type: "message", label: "\u4FDD\u7559", text: `\u4FDD\u7559 ${pendingId}` } },
      { type: "action", action: { type: "message", label: "\u30AD\u30E3\u30F3\u30BB\u30EB", text: `\u30AD\u30E3\u30F3\u30BB\u30EB ${pendingId}` } },
    ],
  };
}

async function draftAndNotify(
  client: messagingApi.MessagingApiClient,
  email: Email,
  userId: string,
  label: string,
): Promise<void> {
  const thread = await getThread(email.threadId, userId);
  const draft = await generateReply(thread, userId);

  const pendingId = createPendingReply({
    userId,
    threadId: email.threadId,
    toAddress: email.from,
    subject: email.subject,
    draftContent: draft,
  });

  const from = (email.from.split("<")[0] ?? "").trim() || email.from;

  await client.pushMessage({
    to: userId,
    messages: [
      {
        type: "text",
        text: `${label}\n\nFrom: ${from}\n\u4EF6\u540D: ${email.subject}\n\n---\n${draft}\n\n\u2192 \u30C0\u30C3\u30B7\u30E5\u30DC\u30FC\u30C9\u3067\u51E6\u7406\u3059\u308B\nhttps://web-production-b2798.up.railway.app/dashboard?token=${userId}`,
        quickReply: makeQuickReply(pendingId),
      },
    ],
  });
}

// ── 5分おき: 新着メール分類 + urgent即通知 + 移動リマインド ──

// 通知済みイベントIDを記録（重複防止）
const notifiedEventIds = new Set<string>();

async function checkNewEmailsForUser(client: messagingApi.MessagingApiClient, userId: string) {
  try {
    const emails = await getUnreadEmails(userId);
    const newEmails = emails.filter((e) => !isEmailProcessed(e.id));

    if (newEmails.length === 0) return;

    console.log(`[auto-draft] ${userId}: ${newEmails.length}\u4EF6\u306E\u65B0\u7740\u30E1\u30FC\u30EB`);

    const accounts = getGoogleAccountsByUserId(userId);
    const userEmails = accounts
      .map((a) => a.email)
      .filter((e): e is string => e !== null);
    const userEmail = userEmails[0];

    for (const email of newEmails.slice(0, 10)) {
      try {
        const category = await classifyEmail(email, userEmail);
        markEmailProcessed(email.id, userId, category);
        console.log(`[auto-draft] ${email.subject} \u2192 ${category}`);

        if (category === "urgent_reply") {
          await draftAndNotify(client, email, userId, "\u3010\u6025\u304E\u3011\u8FD4\u4FE1\u6848:");
        }

        if (category === "action_needed") {
          try {
            const tasks = await extractTasksFromEmail(email);
            for (const t of tasks) {
              createTask(userId, t.title, undefined, t.dueDate, "email", email.id);
              await client.pushMessage({
                to: userId,
                messages: [{
                  type: "text",
                  text: `\u30BF\u30B9\u30AF\u3092\u691C\u51FA\u3057\u307E\u3057\u305F\n${t.title}${t.dueDate ? `\n\u671F\u65E5: ${t.dueDate}` : ""}\n\n\u81EA\u52D5\u3067\u30BF\u30B9\u30AF\u306B\u8FFD\u52A0\u3057\u307E\u3057\u305F\u3002\n\u300C\u30BF\u30B9\u30AF\u898B\u305B\u3066\u300D\u3067\u78BA\u8A8D\u3067\u304D\u307E\u3059\u3002`,
                }],
              });
              console.log(`[auto-draft] \u30BF\u30B9\u30AF\u691C\u51FA: ${t.title}`);
            }
          } catch (taskErr) {
            console.error(`[auto-draft] \u30BF\u30B9\u30AF\u62BD\u51FA\u30A8\u30E9\u30FC (${email.id}):`, taskErr);
          }
        }
      } catch (err) {
        console.error(`[auto-draft] \u5206\u985E\u30A8\u30E9\u30FC (${email.id}):`, err);
        markEmailProcessed(email.id, userId, "fyi");
      }
    }
  } catch (err) {
    console.error(`[auto-draft] \u30C1\u30A7\u30C3\u30AF\u30A8\u30E9\u30FC (${userId}):`, err);
  }
}

async function checkMoveReminder(client: messagingApi.MessagingApiClient, userId: string) {
  try {
    const events = await getTodayEvents(userId);
    const now = Date.now();
    const oneHourMs = 60 * 60 * 1000;
    const fiveMinMs = 5 * 60 * 1000;

    for (const e of events) {
      if (!e.location || !e.start.includes("T")) continue;
      const eventStart = new Date(e.start).getTime();
      const diff = eventStart - now;

      // 開始1時間前 ±5分
      if (diff > oneHourMs - fiveMinMs && diff < oneHourMs + fiveMinMs) {
        const key = `${userId}:${e.id}`;
        if (notifiedEventIds.has(key)) continue;
        notifiedEventIds.add(key);

        const time = new Date(e.start).toLocaleTimeString("ja-JP", { hour: "2-digit", minute: "2-digit" });
        await client.pushMessage({
          to: userId,
          messages: [{
            type: "text",
            text: `\u23F0 1\u6642\u9593\u5F8C\u306B\u4E88\u5B9A\u304C\u3042\u308A\u307E\u3059\n\n${time} ${e.summary} @ ${e.location}\n\n\u305D\u308D\u305D\u308D\u6E96\u5099\u3092\u59CB\u3081\u307E\u3057\u3087\u3046\uFF01`,
          }],
        });
        console.log(`[auto-draft] \u79FB\u52D5\u30EA\u30DE\u30A4\u30F3\u30C9: ${e.summary}`);
      }
    }
  } catch (err) {
    console.error(`[auto-draft] \u79FB\u52D5\u30EA\u30DE\u30A4\u30F3\u30C9\u30A8\u30E9\u30FC (${userId}):`, err);
  }
}

async function checkNewEmails() {
  console.log(`[auto-draft] \u30C1\u30A7\u30C3\u30AF\u958B\u59CB: ${new Date().toISOString()}`);
  const userIds = getAllUserIds();
  if (userIds.length === 0) return;

  const client = getClient();
  for (const userId of userIds) {
    const accounts = getGoogleAccountsByUserId(userId);
    if (accounts.length === 0) continue;
    await checkNewEmailsForUser(client, userId);
    await checkMoveReminder(client, userId);
  }
}

export function startAutoDraft() {
  // 5分おき: 新着分類 + urgent即通知 + 移動リマインド
  cron.schedule("*/5 * * * *", checkNewEmails);
  console.log("[auto-draft] \u30B9\u30B1\u30B8\u30E5\u30FC\u30EB\u767B\u9332\u5B8C\u4E86 (5\u5206\u304A\u304D\u5206\u985E)");
}

export { checkNewEmails };
