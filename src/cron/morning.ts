import cron from "node-cron";
import { messagingApi } from "@line/bot-sdk";
import { generateBriefing, generateNoonBriefing, generateEveningBriefing } from "../agents/briefing.js";
import { getUser, getTrialDaysRemaining, getAllUserIds, getGoogleAccountsByUserId } from "../db/queries.js";

function getClient() {
  return new messagingApi.MessagingApiClient({
    channelAccessToken: process.env["LINE_CHANNEL_ACCESS_TOKEN"] || "",
  });
}

async function sendToUser(client: messagingApi.MessagingApiClient, userId: string, text: string) {
  try {
    await client.pushMessage({ to: userId, messages: [{ type: "text", text }] });
  } catch (err) {
    console.error(`[cron] \u9001\u4FE1\u5931\u6557 (${userId}):`, err);
  }
}

function getActiveUserIds(): string[] {
  return getAllUserIds().filter((id) => getGoogleAccountsByUserId(id).length > 0);
}

// ── 朝 8:00（Haiku使用） ──

async function sendMorningBriefing() {
  console.log(`[cron] \u671D\u30D6\u30EA\u30FC\u30D5\u30A3\u30F3\u30B0\u958B\u59CB: ${new Date().toISOString()}`);
  const userIds = getActiveUserIds();
  if (userIds.length === 0) return;

  const client = getClient();
  for (const userId of userIds) {
    try {
      let text = await generateBriefing(userId);
      const user = getUser(userId);
      if (user?.plan === "trial") {
        const remaining = getTrialDaysRemaining(userId);
        if (remaining <= 2 && remaining > 0) {
          text += `\n\n\u7121\u6599\u4F53\u9A13\u6B8B\u308A${remaining}\u65E5\u3067\u3059\u3002`;
        }
      }
      await sendToUser(client, userId, text);
      console.log(`[cron] \u671D\u30D6\u30EA\u30FC\u30D5\u30A3\u30F3\u30B0\u9001\u4FE1\u5B8C\u4E86: ${userId}`);
    } catch (err) {
      console.error(`[cron] \u671D\u30D6\u30EA\u30FC\u30D5\u30A3\u30F3\u30B0\u30A8\u30E9\u30FC (${userId}):`, err);
      await sendToUser(client, userId, "\u30D6\u30EA\u30FC\u30D5\u30A3\u30F3\u30B0\u306E\u751F\u6210\u306B\u5931\u6557\u3057\u307E\u3057\u305F\u3002");
    }
  }
}

// ── 昼 12:00（ルールベース） ──

async function sendNoonBriefing() {
  console.log(`[cron] \u663C\u30D6\u30EA\u30FC\u30D5\u30A3\u30F3\u30B0\u958B\u59CB: ${new Date().toISOString()}`);
  const userIds = getActiveUserIds();
  if (userIds.length === 0) return;

  const client = getClient();
  for (const userId of userIds) {
    try {
      const text = await generateNoonBriefing(userId);
      await sendToUser(client, userId, text);
    } catch (err) {
      console.error(`[cron] \u663C\u30D6\u30EA\u30FC\u30D5\u30A3\u30F3\u30B0\u30A8\u30E9\u30FC (${userId}):`, err);
    }
  }
}

// ── 夜 21:00（ルールベース） ──

async function sendEveningBriefing() {
  console.log(`[cron] \u591C\u30D6\u30EA\u30FC\u30D5\u30A3\u30F3\u30B0\u958B\u59CB: ${new Date().toISOString()}`);
  const userIds = getActiveUserIds();
  if (userIds.length === 0) return;

  const client = getClient();
  for (const userId of userIds) {
    try {
      const text = await generateEveningBriefing(userId);
      await sendToUser(client, userId, text);
    } catch (err) {
      console.error(`[cron] \u591C\u30D6\u30EA\u30FC\u30D5\u30A3\u30F3\u30B0\u30A8\u30E9\u30FC (${userId}):`, err);
    }
  }
}

export function startCron() {
  cron.schedule("0 8 * * *", sendMorningBriefing);
  cron.schedule("0 12 * * *", sendNoonBriefing);
  cron.schedule("0 21 * * *", sendEveningBriefing);
  console.log("[cron] \u30D6\u30EA\u30FC\u30D5\u30A3\u30F3\u30B0 8:00/12:00/21:00 \u30B9\u30B1\u30B8\u30E5\u30FC\u30EB\u767B\u9332\u5B8C\u4E86");
}

export { sendMorningBriefing, sendNoonBriefing, sendEveningBriefing };
