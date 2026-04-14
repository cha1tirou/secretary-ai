import { Hono } from "hono";
import type Stripe from "stripe";
import { messagingApi } from "@line/bot-sdk";
import {
  constructWebhookEvent,
  resolvePlanFromSubscription,
} from "../integrations/stripe.js";
import {
  getUserByStripeCustomerId,
  updateUserPlanAndExpiry,
  updateStripeIds,
} from "../db/queries.js";

const stripeWebhook = new Hono();

function lineClient() {
  return new messagingApi.MessagingApiClient({
    channelAccessToken: process.env["LINE_CHANNEL_ACCESS_TOKEN"] ?? "",
  });
}

async function notifyPlanActive(userId: string, plan: string, periodEnd: string) {
  const limits: Record<string, number> = { lite: 30, standard: 60, pro: 150 };
  const limit = limits[plan] ?? 30;
  const endLabel = new Date(periodEnd).toLocaleDateString("ja-JP", {
    year: "numeric", month: "2-digit", day: "2-digit",
  });
  const planLabel = plan.charAt(0).toUpperCase() + plan.slice(1);
  try {
    await lineClient().pushMessage({
      to: userId,
      messages: [{
        type: "text",
        text: [
          `🎉 ${planLabel}プランが有効になりました`,
          "",
          `・今月の送信上限: ${limit}通`,
          `・次回更新: ${endLabel}`,
          "・解約はいつでも「解約」と送ってください",
        ].join("\n"),
      }],
    });
  } catch (err) {
    console.error("[stripe] notify plan active error:", err);
  }
}

async function notifyPaymentFailed(userId: string, portalUrl: string | null) {
  try {
    const lines = [
      "💳 決済に失敗しました",
      "",
      "カード情報の確認をお願いします👇",
    ];
    if (portalUrl) lines.push(portalUrl);
    lines.push("", "一時的にFreeプラン（5通/月）に戻っています。", "更新完了後、自動で元のプランに戻ります。");
    await lineClient().pushMessage({
      to: userId,
      messages: [{ type: "text", text: lines.join("\n") }],
    });
  } catch (err) {
    console.error("[stripe] notify payment failed error:", err);
  }
}

async function notifySubscriptionEnded(userId: string) {
  try {
    await lineClient().pushMessage({
      to: userId,
      messages: [{
        type: "text",
        text: "プランが終了しました。Freeプラン（5通/月）に戻っています。\n続けるなら「プラン」と送ってください。",
      }],
    });
  } catch (err) {
    console.error("[stripe] notify subscription ended error:", err);
  }
}

stripeWebhook.post("/stripe/webhook", async (c) => {
  const signature = c.req.header("stripe-signature") ?? "";
  const body = await c.req.text();

  let event: Stripe.Event;
  try {
    event = constructWebhookEvent(body, signature);
  } catch (err) {
    console.error("[stripe] webhook signature error:", err);
    return c.text("Invalid signature", 400);
  }

  console.log(`[stripe] event: ${event.type}`);

  try {
    switch (event.type) {
      case "checkout.session.completed": {
        const session = event.data.object as Stripe.Checkout.Session;
        const userId = (session.metadata?.["line_user_id"] as string | undefined) ?? "";
        const customerId = typeof session.customer === "string" ? session.customer : session.customer?.id ?? null;
        const subscriptionId = typeof session.subscription === "string" ? session.subscription : session.subscription?.id ?? null;
        if (userId && customerId) {
          updateStripeIds(userId, customerId, subscriptionId);
        }
        break;
      }

      case "customer.subscription.created":
      case "customer.subscription.updated": {
        const sub = event.data.object as Stripe.Subscription;
        const customerId = typeof sub.customer === "string" ? sub.customer : sub.customer.id;
        const user = getUserByStripeCustomerId(customerId);
        if (!user) {
          console.warn("[stripe] user not found for customer:", customerId);
          break;
        }
        const { plan, periodEnd } = resolvePlanFromSubscription(sub);
        if (!plan) {
          console.warn("[stripe] plan could not be resolved");
          break;
        }
        // status が active / trialing のときだけ plan を付与
        if (sub.status === "active" || sub.status === "trialing") {
          updateUserPlanAndExpiry(user.userId, plan, periodEnd);
          updateStripeIds(user.userId, customerId, sub.id);
          if (event.type === "customer.subscription.created") {
            await notifyPlanActive(user.userId, plan, periodEnd);
          }
        } else if (sub.status === "past_due" || sub.status === "unpaid" || sub.status === "incomplete_expired") {
          updateUserPlanAndExpiry(user.userId, "expired", null);
        }
        break;
      }

      case "customer.subscription.deleted": {
        const sub = event.data.object as Stripe.Subscription;
        const customerId = typeof sub.customer === "string" ? sub.customer : sub.customer.id;
        const user = getUserByStripeCustomerId(customerId);
        if (!user) break;
        updateUserPlanAndExpiry(user.userId, "free", null);
        updateStripeIds(user.userId, customerId, null);
        await notifySubscriptionEnded(user.userId);
        break;
      }

      case "invoice.payment_failed": {
        const invoice = event.data.object as Stripe.Invoice & { customer?: string | { id: string } };
        const customerId = typeof invoice.customer === "string" ? invoice.customer : invoice.customer?.id ?? null;
        if (!customerId) break;
        const user = getUserByStripeCustomerId(customerId);
        if (!user) break;
        // 即 expired に落とす（設計3A）
        updateUserPlanAndExpiry(user.userId, "expired", null);
        const portalUrl = (invoice.hosted_invoice_url as string | undefined) ?? null;
        await notifyPaymentFailed(user.userId, portalUrl);
        break;
      }

      default:
        // 他イベントは無視
        break;
    }
  } catch (err) {
    console.error("[stripe] webhook handler error:", err);
  }

  return c.text("ok");
});

export { stripeWebhook };
