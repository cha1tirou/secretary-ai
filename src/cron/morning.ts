import cron from "node-cron";
import { messagingApi } from "@line/bot-sdk";
import { generateBriefing } from "../agents/briefing.js";
import { getUser, getTrialDaysRemaining, getAllUserIds, getGoogleAccountsByUserId } from "../db/queries.js";

function getClient() {
  return new messagingApi.MessagingApiClient({
    channelAccessToken: process.env["LINE_CHANNEL_ACCESS_TOKEN"] || "",
  });
}

async function sendBriefingForUser(client: messagingApi.MessagingApiClient, userId: string) {
  const accounts = getGoogleAccountsByUserId(userId);
  if (accounts.length === 0) return; // Google未連携ユーザーはスキップ
  const user = getUser(userId);

  console.log(`[cron] ブリーフィング生成: userId=${userId}`);
  try {
    let text = await generateBriefing(userId);

    // trial残日数通知
    if (user?.plan === "trial") {
      const remaining = getTrialDaysRemaining(userId);
      if (remaining <= 2 && remaining > 0) {
        text += `\n\n無料体験残り${remaining}日です。`;
      }
    }

    await client.pushMessage({ to: userId, messages: [{ type: "text", text }] });
    console.log(`[cron] ブリーフィング送信完了: userId=${userId}`);
  } catch (err) {
    console.error(`[cron] ブリーフィング送信エラー (${userId}):`, err);
    try {
      await client.pushMessage({
        to: userId,
        messages: [{ type: "text", text: "ブリーフィングの生成に失敗しました。" }],
      });
    } catch {
      console.error(`[cron] エラー通知も失敗 (${userId})`);
    }
  }
}

async function sendMorningBriefing() {
  console.log(`[cron] ブリーフィング開始: ${new Date().toISOString()}`);
  const userIds = getAllUserIds();
  if (userIds.length === 0) {
    console.log("[cron] 登録ユーザーなし");
    return;
  }

  const client = getClient();
  for (const userId of userIds) {
    await sendBriefingForUser(client, userId);
  }
}

export function startCron() {
  // 毎朝8時 (TZ=Asia/Tokyo は .env で設定済み)
  cron.schedule("0 8 * * *", sendMorningBriefing);
  console.log("[cron] 毎朝8:00 ブリーフィング スケジュール登録完了");
}

// テスト用: 手動で即時実行
export { sendMorningBriefing };
