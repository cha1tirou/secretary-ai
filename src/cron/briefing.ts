import cron from "node-cron";
import { messagingApi } from "@line/bot-sdk";
import { getAllUsers, clearBriefingItems, saveBriefingItems } from "../db/queries.js";
import { runAgentRaw } from "../agent/index.js";
import type { BriefingItem } from "../types.js";

function getClient() {
  return new messagingApi.MessagingApiClient({
    channelAccessToken: process.env["LINE_CHANNEL_ACCESS_TOKEN"] || "",
  });
}

type TimeOfDay = "morning" | "noon" | "evening";

const JSON_INSTRUCTION = `

必ず以下のJSON形式のみで返してください（説明文やマークダウンは不要、JSONだけ）：
{
  "message": "LINEに送るテキスト（番号付き）",
  "items": [
    {"number": 1, "emailId": "メールID", "threadId": "スレッドID", "type": "reply_needed", "summary": "送信者：件名要約"}
  ]
}

messageのフォーマット：
- 要返信メールは ① ② ③ の丸数字で番号付け
- フォローアップも続きの番号で番号付け
- 最後に「番号を送ると詳細を確認できます」と追記
- type は reply_needed / followup / fyi のいずれか
- 要対応なしの場合は items を空配列で返す
- emailId と threadId はツールから取得した実際の値を使う`;

function getBriefingPrompt(timeOfDay: TimeOfDay): string {
  switch (timeOfDay) {
    case "morning":
      return `今日の朝のブリーフィングです。以下の順で報告してください：
1. 要返信メール（自分宛て・未返信）を優先度順に列挙
2. フォローアップ推奨（自分が送って返信なし3日以上）
3. 新着FYIの件数だけ報告
4. 今日のカレンダー予定

ノイズメール（noreply・マーケ等）は無視。
要返信が0件なら「要返信なし」と明記。${JSON_INSTRUCTION}`;

    case "noon":
      return `午前中の新着メールを確認してください。以下があれば報告：
1. 要返信の新着メール
2. 新たにフォローアップが必要になったもの
何もなければ message に「午前中に要対応メールはありませんでした」、items は空配列で返してください。${JSON_INSTRUCTION}`;

    case "evening":
      return `今日の夕方ブリーフィングです。以下を確認して報告：
1. 本日中に未対応の要返信メール
2. フォローアップ推奨（返信なし3日以上）
3. 明日のカレンダー予定
何もなければ message に「今日の対応は完了です」、items は空配列で返してください。${JSON_INSTRUCTION}`;
  }
}

interface BriefingResponse {
  message: string;
  items: Array<{
    number: number;
    emailId: string;
    threadId: string;
    type: "reply_needed" | "followup" | "fyi";
    summary: string;
  }>;
}

function parseBriefingResponse(raw: string): BriefingResponse {
  // JSONブロックを抽出（```json ... ``` やプレーンJSON両対応）
  const jsonMatch = raw.match(/```json\s*([\s\S]*?)```/) || raw.match(/(\{[\s\S]*\})/);
  if (!jsonMatch) {
    return { message: raw, items: [] };
  }
  try {
    return JSON.parse(jsonMatch[1]!) as BriefingResponse;
  } catch {
    return { message: raw, items: [] };
  }
}

async function sendBriefing(timeOfDay: TimeOfDay) {
  const client = getClient();
  const users = getAllUsers();

  console.log(`[briefing] ${timeOfDay} start — ${users.length} users`);

  for (const user of users) {
    try {
      const prompt = getBriefingPrompt(timeOfDay);
      const rawResponse = await runAgentRaw(
        user.lineUserId,
        prompt,
        user.displayName ?? "ユーザー",
      );

      const { message, items } = parseBriefingResponse(rawResponse);

      // 昼・夜はアイテムがなければスキップ
      if (timeOfDay !== "morning" && items.length === 0) continue;

      // DBに保存（古いアイテムをクリアして新しいものを保存）
      clearBriefingItems(user.lineUserId);
      if (items.length > 0) {
        const briefingItems: BriefingItem[] = items.map((i) => ({
          lineUserId: user.lineUserId,
          number: i.number,
          emailId: i.emailId,
          threadId: i.threadId,
          type: i.type,
          summary: i.summary,
        }));
        saveBriefingItems(user.lineUserId, briefingItems);
      }

      await client.pushMessage({
        to: user.lineUserId,
        messages: [{ type: "text", text: message }],
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
