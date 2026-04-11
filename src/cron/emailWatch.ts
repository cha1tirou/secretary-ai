import cron from "node-cron";
import { messagingApi } from "@line/bot-sdk";
import {
  getAllActiveEmailWatchRules,
  isEmailWatchNotified,
  markEmailWatchNotified,
} from "../db/queries.js";
import { getUnreadEmails } from "../integrations/gmail.js";
import type { Email } from "../types.js";

function getClient() {
  return new messagingApi.MessagingApiClient({
    channelAccessToken: process.env["LINE_CHANNEL_ACCESS_TOKEN"] || "",
  });
}

function emailMatchesRule(
  email: Email,
  matchType: string,
  pattern: string,
  pattern2?: string | null,
): boolean {
  const p = pattern.toLowerCase();
  switch (matchType) {
    case "from":
      return email.from.toLowerCase().includes(p);
    case "subject":
      return email.subject.toLowerCase().includes(p);
    case "keyword":
      return (
        email.from.toLowerCase().includes(p) ||
        email.subject.toLowerCase().includes(p) ||
        email.body.toLowerCase().includes(p)
      );
    case "from_and_keyword": {
      if (!email.from.toLowerCase().includes(p)) return false;
      if (!pattern2) return true;
      const p2 = pattern2.toLowerCase();
      return (
        email.subject.toLowerCase().includes(p2) ||
        email.body.toLowerCase().includes(p2)
      );
    }
    default:
      return false;
  }
}

export function startEmailWatchCron() {
  // 3分ごとにチェック
  cron.schedule("*/3 * * * *", async () => {
    const client = getClient();
    const rules = getAllActiveEmailWatchRules();
    if (rules.length === 0) return;

    // ユーザーごとにルールをグループ化（メール取得を1回で済ませる）
    const rulesByUser = new Map<string, typeof rules>();
    for (const rule of rules) {
      const list = rulesByUser.get(rule.userId) ?? [];
      list.push(rule);
      rulesByUser.set(rule.userId, list);
    }

    for (const [userId, userRules] of rulesByUser) {
      try {
        const emails = await getUnreadEmails(userId);
        let rateLimited = false;

        for (const rule of userRules) {
          if (rateLimited) break;
          for (const email of emails) {
            if (rateLimited) break;
            if (
              emailMatchesRule(email, rule.matchType, rule.pattern, rule.pattern2) &&
              !isEmailWatchNotified(rule.id, email.id)
            ) {
              const from = (email.from.split("<")[0] ?? "").trim() || email.from;
              console.log(`[emailWatch] match: rule=${rule.id}(${rule.matchType}:${rule.pattern}) email=${email.id} from="${from}" subject="${email.subject}"`);
              try {
                await client.pushMessage({
                  to: userId,
                  messages: [{
                    type: "text",
                    text: `📩 メール通知: ${rule.description}\n\n件名: ${email.subject}\n送信者: ${from}\n日時: ${email.date}`,
                  }],
                });
                markEmailWatchNotified(rule.id, email.id);
              } catch (pushErr) {
                const errMsg = pushErr instanceof Error ? pushErr.message : String(pushErr);
                if (errMsg.includes("429") || errMsg.includes("monthly limit")) {
                  console.warn(`[emailWatch] LINE push rate limited for ${userId}, skipping remaining`);
                  rateLimited = true;
                } else {
                  console.error(`[emailWatch] push error for rule=${rule.id}:`, pushErr);
                }
                markEmailWatchNotified(rule.id, email.id);
              }
            }
          }
        }
      } catch (err) {
        console.error(`[emailWatch] error for ${userId}:`, err);
      }
    }
  }, { timezone: "Asia/Tokyo" });

  console.log("[emailWatch] cron起動完了（3分ごとにチェック）");
}
