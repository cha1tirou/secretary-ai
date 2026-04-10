import cron from "node-cron";
import { messagingApi } from "@line/bot-sdk";
import { getPendingTimers, markTimerDone } from "../db/queries.js";

function getClient() {
  return new messagingApi.MessagingApiClient({
    channelAccessToken: process.env["LINE_CHANNEL_ACCESS_TOKEN"] || "",
  });
}

export function startTimerCron() {
  // 1分ごとにタイマーをチェック
  cron.schedule("* * * * *", async () => {
    const client = getClient();
    const now = new Date().toISOString();
    const timers = getPendingTimers();

    for (const timer of timers) {
      if (timer.fireAt <= now) {
        try {
          await client.pushMessage({
            to: timer.lineUserId,
            messages: [{ type: "text", text: `⏰ リマインドです！\n${timer.message}` }],
          });
          markTimerDone(timer.id);
        } catch (err) {
          console.error("[timer] push error:", err);
        }
      }
    }
  }, { timezone: "Asia/Tokyo" });

  console.log("[timer] cron起動完了（1分ごとにチェック）");
}
