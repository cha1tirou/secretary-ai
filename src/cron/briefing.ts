import cron from "node-cron";
import { messagingApi } from "@line/bot-sdk";
import { getAllUsers } from "../db/queries.js";
import { runAgent } from "../agent/index.js";

function getClient() {
  return new messagingApi.MessagingApiClient({
    channelAccessToken: process.env["LINE_CHANNEL_ACCESS_TOKEN"] || "",
  });
}

type TimeOfDay = "morning" | "noon" | "evening";

function getBriefingPrompt(timeOfDay: TimeOfDay): string {
  switch (timeOfDay) {
    case "morning":
      return `今日の朝のブリーフィングです。以下の順で報告してください：
1. ⚠️ 要返信メール（自分宛て・未返信）を優先度順に列挙
2. 📌 フォローアップ推奨（自分が送って返信なし3日以上）
3. 📋 新着FYIの件数だけ報告
4. 📅 今日のカレンダー予定

LINEで読みやすいよう箇条書きで簡潔に。ノイズメール（noreply・マーケ等）は無視。
要返信が0件なら「⚠️ 要返信なし」と明記。`;

    case "noon":
      return `午前中の新着メールを確認してください。以下があれば報告：
1. ⚠️ 要返信の新着メール
2. 📌 新たにフォローアップが必要になったもの
何もなければ「午前中に要対応メールはありませんでした」と返してください。`;

    case "evening":
      return `今日の夕方ブリーフィングです。以下を確認して報告：
1. ⚠️ 本日中に未対応の要返信メール
2. 📌 フォローアップ推奨（返信なし3日以上）
3. 📅 明日のカレンダー予定
何もなければ「今日の対応は完了です 👍」と返してください。`;
  }
}

function isEmptyBriefing(response: string): boolean {
  const emptyKeywords = ["ありませんでした", "完了です", "要対応なし", "新着なし"];
  return emptyKeywords.some((k) => response.includes(k));
}

async function sendBriefing(timeOfDay: TimeOfDay) {
  const client = getClient();
  const users = getAllUsers();

  console.log(`[briefing] ${timeOfDay} start — ${users.length} users`);

  for (const user of users) {
    try {
      const prompt = getBriefingPrompt(timeOfDay);
      const response = await runAgent(user.lineUserId, prompt, user.displayName ?? "ユーザー");

      // 昼・夜は「なし」系の返答ならスキップ
      if (timeOfDay !== "morning" && isEmptyBriefing(response)) continue;

      await client.pushMessage({
        to: user.lineUserId,
        messages: [{ type: "text", text: response }],
      });
    } catch (err) {
      console.error(`[briefing] error for ${user.lineUserId}:`, err);
    }
  }

  console.log(`[briefing] ${timeOfDay} done`);
}

export function startBriefing() {
  // 朝8時（JST）
  cron.schedule("0 8 * * *", () => sendBriefing("morning"), { timezone: "Asia/Tokyo" });
  // 昼12時（JST）
  cron.schedule("0 12 * * *", () => sendBriefing("noon"), { timezone: "Asia/Tokyo" });
  // 夜18時（JST）
  cron.schedule("0 18 * * *", () => sendBriefing("evening"), { timezone: "Asia/Tokyo" });

  console.log("[briefing] スケジュール登録完了 8:00/12:00/18:00");
}
