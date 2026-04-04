import cron from "node-cron";
import { messagingApi, type QuickReplyItem } from "@line/bot-sdk";
import { getUnreadEmails, getThread } from "../integrations/gmail.js";
import { generateReply } from "../agents/reply.js";
import { classifyEmail, extractTasksFromEmail } from "../agents/classifier.js";
import {
  getDb,
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
      { type: "action", action: { type: "message", label: "送信", text: `送信 ${pendingId}` } },
      { type: "action", action: { type: "message", label: "保留", text: `保留 ${pendingId}` } },
      { type: "action", action: { type: "message", label: "キャンセル", text: `キャンセル ${pendingId}` } },
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
        text: `${label}\n\nFrom: ${from}\n件名: ${email.subject}\n\n---\n${draft}`,
        quickReply: makeQuickReply(pendingId),
      },
    ],
  });
}

// ── 5分おき: 新着メール分類 + urgent即通知 ──

async function checkNewEmails() {
  const userId = process.env["LINE_USER_ID"];
  if (!userId) return;

  console.log(`[auto-draft] チェック開始: ${new Date().toISOString()}`);

  try {
    const emails = await getUnreadEmails(userId);
    const newEmails = emails.filter((e) => !isEmailProcessed(e.id));

    if (newEmails.length === 0) {
      console.log("[auto-draft] 新着なし");
      return;
    }

    console.log(`[auto-draft] ${newEmails.length}件の新着メール`);
    const client = getClient();

    for (const email of newEmails.slice(0, 10)) {
      try {
        const category = await classifyEmail(email);
        markEmailProcessed(email.id, userId, category);
        console.log(`[auto-draft] ${email.subject} → ${category}`);

        // urgent は即座にドラフト生成・通知
        if (category === "reply_urgent") {
          await draftAndNotify(client, email, userId, "【急ぎ】返信案:");
        }

        // タスク自動抽出
        if (category !== "newsletter" && category !== "other") {
          try {
            const tasks = await extractTasksFromEmail(email);
            for (const t of tasks) {
              const taskId = createTask(userId, t.title, undefined, t.dueDate, "email", email.id);
              await client.pushMessage({
                to: userId,
                messages: [{
                  type: "text",
                  text: `タスクを検出しました\n${t.title}${t.dueDate ? `\n期日: ${t.dueDate}` : ""}\n\n自動でタスクに追加しました。\n「タスク見せて」で確認できます。`,
                }],
              });
              console.log(`[auto-draft] タスク検���: ${t.title}`);
            }
          } catch (taskErr) {
            console.error(`[auto-draft] タスク抽出エラー (${email.id}):`, taskErr);
          }
        }
      } catch (err) {
        console.error(`[auto-draft] 分類エラー (${email.id}):`, err);
        markEmailProcessed(email.id, userId, "other");
      }
    }
  } catch (err) {
    console.error("[auto-draft] チェックエラー:", err);
  }
}

// ── 1日3回 (10時/15時/19時): reply_later まとめ通知 ──

async function notifyReplyLater() {
  const userId = process.env["LINE_USER_ID"];
  if (!userId) return;

  console.log(`[auto-draft] reply_later まとめ通知: ${new Date().toISOString()}`);

  try {
    const emails = await getUnreadEmails(userId);
    // reply_laterとして分類済みで、まだ未読のメールを探す
    const replyLaterEmails = emails.filter((e) => {
      if (!isEmailProcessed(e.id)) return false;
      // processed_emailsからcategoryを取得
      const row = getDb()
        .prepare("SELECT category FROM processed_emails WHERE message_id = ?")
        .get(e.id) as { category: string } | undefined;
      return row?.category === "reply_later";
    });

    if (replyLaterEmails.length === 0) {
      console.log("[auto-draft] reply_later 対象なし");
      return;
    }

    const client = getClient();

    for (const email of replyLaterEmails.slice(0, 5)) {
      try {
        await draftAndNotify(client, email, userId, "返信案:");
        // 通知済みとしてcategoryを更新（再通知防止）
        getDb()
          .prepare("UPDATE processed_emails SET category = 'other' WHERE message_id = ?")
          .run(email.id);
      } catch (err) {
        console.error(`[auto-draft] reply_later ドラフトエラー (${email.id}):`, err);
      }
    }
  } catch (err) {
    console.error("[auto-draft] reply_later まとめ通知エラー:", err);
  }
}

export function startAutoDraft() {
  // 5分おき: 新着分類 + urgent即通知
  cron.schedule("*/5 * * * *", checkNewEmails);
  // 10時・15時・19時: reply_later まとめ通知
  cron.schedule("0 10,15,19 * * *", notifyReplyLater);
  console.log("[auto-draft] スケジュール登録完了 (5分おき分類 + 10/15/19時まとめ)");
}

export { checkNewEmails, notifyReplyLater };
