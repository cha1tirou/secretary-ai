import cron from "node-cron";
import { messagingApi } from "@line/bot-sdk";
import { getTodayEvents } from "../integrations/gcal.js";
import { getAllUserIds, getGoogleAccountsByUserId } from "../db/queries.js";

function getClient() {
  return new messagingApi.MessagingApiClient({
    channelAccessToken: process.env["LINE_CHANNEL_ACCESS_TOKEN"] || "",
  });
}

const notifiedEventIds = new Set<string>();

async function checkMoveReminder(
  client: messagingApi.MessagingApiClient,
  userId: string,
) {
  try {
    const events = await getTodayEvents(userId);
    const now = Date.now();
    const oneHourMs = 60 * 60 * 1000;
    const fiveMinMs = 5 * 60 * 1000;

    for (const e of events) {
      if (!e.location || !e.start.includes("T")) continue;
      const eventStart = new Date(e.start).getTime();
      const diff = eventStart - now;

      if (diff > oneHourMs - fiveMinMs && diff < oneHourMs + fiveMinMs) {
        const key = `${userId}:${e.id}`;
        if (notifiedEventIds.has(key)) continue;
        notifiedEventIds.add(key);

        const time = new Date(e.start).toLocaleTimeString("ja-JP", {
          hour: "2-digit",
          minute: "2-digit",
        });
        await client.pushMessage({
          to: userId,
          messages: [{
            type: "text",
            text: `\u23F0 1\u6642\u9593\u5F8C\u306B\u4E88\u5B9A\u304C\u3042\u308A\u307E\u3059\n\n${time} ${e.summary} @ ${e.location}\n\n\u305D\u308D\u305D\u308D\u6E96\u5099\u3092\u59CB\u3081\u307E\u3057\u3087\u3046\uFF01`,
          }],
        });
      }
    }
  } catch (err) {
    console.error(`[move-reminder] \u30A8\u30E9\u30FC (${userId}):`, err);
  }
}

async function checkMoveReminders() {
  const userIds = getAllUserIds();
  if (userIds.length === 0) return;
  const client = getClient();
  for (const userId of userIds) {
    const accounts = getGoogleAccountsByUserId(userId);
    if (accounts.length === 0) continue;
    await checkMoveReminder(client, userId);
  }
}

export function startAutoDraft() {
  cron.schedule("*/5 * * * *", checkMoveReminders);
  console.log("[auto-draft] \u79FB\u52D5\u30EA\u30DE\u30A4\u30F3\u30C9 \u30B9\u30B1\u30B8\u30E5\u30FC\u30EB\u767B\u9332\u5B8C\u4E86 (5\u5206\u304A\u304D)");
}
