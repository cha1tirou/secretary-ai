import { getMonthlyUsage, getResetDate, USAGE_LIMITS } from "../db/queries.js";

export async function checkAndNotifyUsageAlert(
  userId: string,
  plan: string,
  actionType: string,
): Promise<void> {
  try {
    const limit = USAGE_LIMITS[plan]?.[actionType] ?? 0;
    if (limit === 0) return;
    const used = getMonthlyUsage(userId, actionType);
    const remaining = limit - used;
    const threshold = Math.floor(limit * 0.8);
    const resetDate = getResetDate();
    const proLimit = USAGE_LIMITS["pro"]?.[actionType] ?? 0;

    const isAt80 = used === threshold + 1;
    const isLow = remaining <= 3 && remaining > 0 && !isAt80;

    if (!isAt80 && !isLow) return;

    const { messagingApi } = await import("@line/bot-sdk");
    const client = new messagingApi.MessagingApiClient({
      channelAccessToken: process.env["LINE_CHANNEL_ACCESS_TOKEN"] ?? "",
    });

    const text = isLow
      ? `\u26A0\uFE0F \u30AF\u30EC\u30B8\u30C3\u30C8\u304C\u6B8B\u308A${remaining}\u306B\u306A\u308A\u307E\u3057\u305F\n\n\u4ECA\u6708\u306E\u4F7F\u7528\uFF1A${used} / ${limit}\u30AF\u30EC\u30B8\u30C3\u30C8\n\u30EA\u30BB\u30C3\u30C8\u65E5\uFF1A${resetDate}\n\n\u30D7\u30ED\u30D7\u30E9\u30F3\u3067${proLimit}\u30AF\u30EC\u30B8\u30C3\u30C8/\u6708\u3054\u5229\u7528\u3044\u305F\u3060\u3051\u307E\u3059\u3002`
      : `\u26A0\uFE0F \u4ECA\u6708\u306E\u30AF\u30EC\u30B8\u30C3\u30C8\u304C\u6B8B\u308A\u308F\u305A\u304B\u3067\u3059\n\n\u4F7F\u7528\u6E08\u307F\uFF1A${used} / ${limit}\u30AF\u30EC\u30B8\u30C3\u30C8\n\u6B8B\u308A\uFF1A${remaining}\u30AF\u30EC\u30B8\u30C3\u30C8\n\u30EA\u30BB\u30C3\u30C8\u65E5\uFF1A${resetDate}\n\n\u30D7\u30ED\u30D7\u30E9\u30F3\u3067${proLimit}\u30AF\u30EC\u30B8\u30C3\u30C8/\u6708\u3054\u5229\u7528\u3044\u305F\u3060\u3051\u307E\u3059\u3002`;

    await client.pushMessage({
      to: userId,
      messages: [{ type: "text", text }],
    });
  } catch (err) {
    console.error("[usage] alert error:", err);
  }
}
