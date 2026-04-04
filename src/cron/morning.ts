import cron from "node-cron";
import { messagingApi } from "@line/bot-sdk";
import { generateBriefing } from "../agents/briefing.js";
import { getUser, getTrialDaysRemaining } from "../db/queries.js";

function getClient() {
  return new messagingApi.MessagingApiClient({
    channelAccessToken: process.env["LINE_CHANNEL_ACCESS_TOKEN"] || "",
  });
}

async function sendMorningBriefing() {
  const userId = process.env["LINE_USER_ID"];
  if (!userId) {
    console.error("[cron] LINE_USER_ID が未設定");
    return;
  }

  console.log(`[cron] ブリーフィング生成開始: ${new Date().toISOString()}`);
  try {
    let text = await generateBriefing(userId);

    // trial残日数通知
    const user = getUser(userId);
    if (user?.plan === "trial") {
      const remaining = getTrialDaysRemaining(userId);
      if (remaining <= 2 && remaining > 0) {
        text += `\n\n無料体験残り${remaining}日です。`;
      }
    }

    const client = getClient();
    await client.pushMessage({ to: userId, messages: [{ type: "text", text }] });
    console.log("[cron] ブリーフィング送信完了");
  } catch (err) {
    console.error("[cron] ブリーフィング送信エラー:", err);
    // CLAUDE.mdルール5: エラー時はLINEで通知
    try {
      const client = getClient();
      await client.pushMessage({
        to: userId,
        messages: [{ type: "text", text: "ブリーフィングの生成に失敗しました。" }],
      });
    } catch {
      console.error("[cron] エラー通知も失敗");
    }
  }
}

export function startCron() {
  // 毎朝8時 (TZ=Asia/Tokyo は .env で設定済み)
  cron.schedule("0 8 * * *", sendMorningBriefing);
  console.log("[cron] 毎朝8:00 ブリーフィング スケジュール登録完了");
}

// テスト用: 手動で即時実行
export { sendMorningBriefing };
