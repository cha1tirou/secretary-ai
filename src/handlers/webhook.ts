import { Hono } from "hono";
import {
  messagingApi,
  validateSignature,
  type WebhookEvent,
  type MessageEvent,
} from "@line/bot-sdk";
import { sendReply } from "../integrations/gmail.js";
import {
  upsertUser,
  getUser,
  getPendingReply,
  updatePendingReplyStatus,
} from "../db/queries.js";
import { runAgent } from "../agent/index.js";

const webhook = new Hono();

const config = {
  channelSecret: process.env["LINE_CHANNEL_SECRET"] || "",
};

function getClient() {
  return new messagingApi.MessagingApiClient({
    channelAccessToken: process.env["LINE_CHANNEL_ACCESS_TOKEN"] || "",
  });
}

async function handleMessage(
  client: messagingApi.MessagingApiClient,
  messageEvent: MessageEvent,
  text: string,
) {
  const userId = messageEvent.source.userId;
  if (!userId) return;

  // pending_reply の操作（「送信」「保留」「キャンセル」）
  const pendingMatch = text.match(/^(送信|保留|キャンセル)\s*#?(\d+)$/);
  if (pendingMatch) {
    const action = pendingMatch[1];
    const id = Number(pendingMatch[2]);
    const pending = getPendingReply(id);
    if (!pending || pending.userId !== userId) {
      await client.replyMessage({
        replyToken: messageEvent.replyToken,
        messages: [{ type: "text", text: "該当する返信案が見つかりません。" }],
      });
      return;
    }

    if (action === "送信") {
      await client.replyMessage({
        replyToken: messageEvent.replyToken,
        messages: [{ type: "text", text: "メールを送信中..." }],
      });
      try {
        await sendReply(userId, pending.threadId, pending.toAddress, pending.subject, pending.draftContent);
        updatePendingReplyStatus(id, "sent");
        await client.pushMessage({
          to: userId,
          messages: [{ type: "text", text: "メールを送信しました。" }],
        });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        await client.pushMessage({
          to: userId,
          messages: [{ type: "text", text: `送信エラー: ${msg}` }],
        });
      }
    } else if (action === "保留") {
      updatePendingReplyStatus(id, "hold");
      await client.replyMessage({
        replyToken: messageEvent.replyToken,
        messages: [{ type: "text", text: "保留にしました。" }],
      });
    } else {
      updatePendingReplyStatus(id, "cancelled");
      await client.replyMessage({
        replyToken: messageEvent.replyToken,
        messages: [{ type: "text", text: "返信をキャンセルしました。" }],
      });
    }
    return;
  }

  // Agentに全委譲
  // 3秒ルール: まず確認中を返してからバックグラウンドで処理
  await client.replyMessage({
    replyToken: messageEvent.replyToken,
    messages: [{ type: "text", text: "確認中..." }],
  });

  try {
    const user = getUser(userId);
    const userName = user?.displayName ?? "ユーザー";
    const response = await runAgent(userId, text, userName);
    await client.pushMessage({
      to: userId,
      messages: [{ type: "text", text: response }],
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error("[webhook] agent error:", err);
    await client.pushMessage({
      to: userId,
      messages: [{ type: "text", text: `エラー: ${msg}` }],
    });
  }
}

webhook.post("/webhook", async (c) => {
  const body = await c.req.text();
  const signature = c.req.header("x-line-signature") || "";

  if (!validateSignature(body, config.channelSecret, signature)) {
    return c.text("Invalid signature", 403);
  }

  console.log("[webhook] POST /webhook received");

  const parsed = JSON.parse(body) as { events: WebhookEvent[] };
  const client = getClient();

  // 即200返却。処理はバックグラウンド
  Promise.all(
    parsed.events.map(async (event) => {
      // follow イベント（友達追加）
      if (event.type === "follow") {
        const userId = event.source.userId;
        if (!userId) return;
        upsertUser(userId, undefined, "trial");
        const baseUrl = (process.env["GOOGLE_REDIRECT_URI"] ?? "")
          .replace("/auth/callback", "")
          || "https://web-production-b2798.up.railway.app";
        const authUrl = `${baseUrl}/auth/start?user=${userId}&label=${encodeURIComponent("アカウント1")}`;
        await client.pushMessage({
          to: userId,
          messages: [
            {
              type: "text",
              text: [
                "🤖 AI秘書へようこそ！",
                "",
                "メールとカレンダーを管理するAI秘書です。",
                "",
                "📩 メールの要約・返信提案",
                "📅 日程調整・空き時間の確認",
                "",
                "まずはGoogleアカウントを連携してください👇",
                authUrl,
              ].join("\n"),
            },
          ],
        });
        return;
      }

      if (event.type !== "message" || event.message.type !== "text") return;
      const messageEvent = event as MessageEvent;
      const textMessage = messageEvent.message as { type: "text"; text: string };
      await handleMessage(client, messageEvent, textMessage.text);
    }),
  ).catch((err) => {
    console.error("[webhook] background processing error:", err);
  });

  return c.json({ ok: true });
});

export { webhook };
