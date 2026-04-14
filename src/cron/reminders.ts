import cron from "node-cron";
import { messagingApi } from "@line/bot-sdk";
import {
  getAllTrialUsers,
  addTrialReminderSent,
  getActiveUserPromos,
  markUserPromoExpiryNotified,
  markUserPromoExpiredNotified,
  updateUserPlanAndExpiry,
  getUser,
} from "../db/queries.js";

function getClient() {
  return new messagingApi.MessagingApiClient({
    channelAccessToken: process.env["LINE_CHANNEL_ACCESS_TOKEN"] ?? "",
  });
}

function daysSince(iso: string): number {
  const start = new Date(iso).getTime();
  const now = Date.now();
  return Math.floor((now - start) / (24 * 3600 * 1000));
}

async function sendTrialReminders() {
  const client = getClient();
  const users = getAllTrialUsers();
  console.log(`[reminders] trial check — ${users.length} users`);

  for (const u of users) {
    if (!u.trialStartDate) continue;
    const elapsed = daysSince(u.trialStartDate);
    const sent = u.remindersSent.split(",").filter(Boolean);

    // 4日目: 体験あと3日
    if (elapsed >= 3 && elapsed < 5 && !sent.includes("d4")) {
      try {
        await client.pushMessage({
          to: u.lineUserId,
          messages: [{
            type: "text",
            text: [
              "📣 Proプラン体験、あと3日です！",
              "",
              "まだ試してない機能があれば今のうちに👇",
              "",
              "・「未返信の重要メール教えて」",
              "・「田中さんに承諾の返信して」",
              "・「来週の予定まとめて」",
            ].join("\n"),
          }],
        });
        addTrialReminderSent(u.lineUserId, "d4");
      } catch (err) { console.error("[reminders] d4 error:", err); }
    }

    // 6日目: 明日終了
    if (elapsed >= 5 && elapsed < 7 && !sent.includes("d6")) {
      try {
        await client.pushMessage({
          to: u.lineUserId,
          messages: [{
            type: "text",
            text: "⏰ 明日でProプラン体験期間が終了します。\n\n使い続けたい場合は「プラン」と送ってください。",
          }],
        });
        addTrialReminderSent(u.lineUserId, "d6");
      } catch (err) { console.error("[reminders] d6 error:", err); }
    }

    // 8日目: 体験終了 → free に落とす
    if (elapsed >= 7 && !sent.includes("d8")) {
      try {
        updateUserPlanAndExpiry(u.lineUserId, "free", null);
        await client.pushMessage({
          to: u.lineUserId,
          messages: [{
            type: "text",
            text: [
              "体験期間が終了しました。",
              "Freeプラン（5通/月）に切り替わっています。",
              "",
              "続ける場合は「プラン」と送ってください。",
            ].join("\n"),
          }],
        });
        addTrialReminderSent(u.lineUserId, "d8");
      } catch (err) { console.error("[reminders] d8 error:", err); }
    }
  }
}

async function sendPromoReminders() {
  const client = getClient();
  const promos = getActiveUserPromos();
  console.log(`[reminders] promo check — ${promos.length} active`);

  for (const p of promos) {
    const expiresAt = new Date(p.expiresAt);
    const now = Date.now();
    const daysLeft = Math.floor((expiresAt.getTime() - now) / (24 * 3600 * 1000));

    // 7日前通知
    if (daysLeft <= 7 && daysLeft > 0 && !p.expiryNotified) {
      try {
        await client.pushMessage({
          to: p.userId,
          messages: [{
            type: "text",
            text: `プロモ期間があと${daysLeft}日で終わります。\n継続したい場合は「プラン」と送ってください。`,
          }],
        });
        markUserPromoExpiryNotified(p.id);
      } catch (err) { console.error("[reminders] promo expiry notify error:", err); }
    }

    // 終了（当日以降）
    if (daysLeft <= 0 && !p.expiredNotified) {
      try {
        // ユーザーがまだそのプランなら free に戻す（Stripeで新契約してたら触らない）
        const user = getUser(p.userId);
        if (user && user.plan === p.plan) {
          const stripeSub = (user as unknown as { stripeSubscriptionId?: string }).stripeSubscriptionId;
          if (!stripeSub) {
            updateUserPlanAndExpiry(p.userId, "free", null);
          }
        }
        await client.pushMessage({
          to: p.userId,
          messages: [{
            type: "text",
            text: "プロモ期間が終了しました。Freeプランに戻っています。\n続けるなら「プラン」と送ってください。",
          }],
        });
        markUserPromoExpiredNotified(p.id);
      } catch (err) { console.error("[reminders] promo expired notify error:", err); }
    }
  }
}

export function startReminderCron() {
  // 毎日 8:05（ブリーフィングの5分後）に通知チェック
  cron.schedule("5 8 * * *", async () => {
    await sendTrialReminders();
    await sendPromoReminders();
  }, { timezone: "Asia/Tokyo" });

  console.log("[reminders] スケジュール登録完了 8:05");
}
