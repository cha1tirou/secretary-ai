import { Hono } from "hono";
import {
  messagingApi,
  validateSignature,
  type WebhookEvent,
  type MessageEvent,
} from "@line/bot-sdk";
import { handleWithSecretary } from "../agents/secretary.js";
import { sendReply } from "../integrations/gmail.js";
import {
  upsertUser,
  getPendingReply,
  updatePendingReplyStatus,
} from "../db/queries.js";

function getBaseUrl(): string {
  return (
    process.env["BASE_URL"] ||
    process.env["RAILWAY_STATIC_URL"] ||
    "https://web-production-b2798.up.railway.app"
  );
}

function chatBubble(align: "right" | "left", text: string) {
  const isUser = align === "right";
  return {
    type: "box" as const,
    layout: "horizontal" as const,
    justifyContent: isUser ? "flex-end" as const : "flex-start" as const,
    contents: [{
      type: "box" as const,
      layout: "vertical" as const,
      backgroundColor: isUser ? "#06C755" : "#ffffff",
      cornerRadius: "16px",
      paddingAll: "12px",
      maxWidth: "85%",
      contents: [{
        type: "text" as const,
        text,
        size: "sm" as const,
        color: isUser ? "#ffffff" : "#333333",
        wrap: true,
      }],
    }],
  };
}

function featureCard(icon: string, title: string, desc: string) {
  return {
    type: "box" as const,
    layout: "vertical" as const,
    backgroundColor: "#ffffff",
    cornerRadius: "12px",
    paddingAll: "14px",
    spacing: "xs" as const,
    flex: 1,
    contents: [
      { type: "text" as const, text: icon, size: "xxl" as const, align: "center" as const },
      { type: "text" as const, text: title, size: "sm" as const, weight: "bold" as const, align: "center" as const },
      { type: "text" as const, text: desc, size: "xxs" as const, color: "#888888", align: "center" as const, wrap: true },
    ],
  };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function buildWelcomeMessages(userId: string, authUrl: string): any[] {
  // ── 1通目：サービス紹介（2×2 グリッド） ──
  const introFlex = {
    type: "flex",
    altText: "AI秘書へようこそ！",
    contents: {
      type: "bubble",
      size: "giga",
      header: {
        type: "box", layout: "vertical",
        backgroundColor: "#1a1a2e",
        paddingAll: "20px",
        contents: [
          { type: "text", text: "🤖 AI秘書", color: "#ffffff", weight: "bold", size: "xl" },
          { type: "text", text: "LINEで話しかけるだけ。メール・予定・タスクを全部動かします。",
            color: "#cccccc", size: "xs", wrap: true, margin: "sm" },
        ],
      },
      body: {
        type: "box", layout: "vertical",
        backgroundColor: "#f0f0f5",
        paddingAll: "16px",
        spacing: "sm",
        contents: [
          { type: "box", layout: "horizontal", spacing: "sm",
            contents: [
              featureCard("📧", "メール管理", "重要メール通知\n返信文を自動下書き"),
              featureCard("📅", "予定管理", "カレンダー確認・登録\n空き時間の計算"),
            ],
          },
          { type: "box", layout: "horizontal", spacing: "sm",
            contents: [
              featureCard("🌅", "ブリーフィング", "毎朝の予定・メール\nまとめを自動配信"),
              featureCard("✅", "タスク管理", "メールからタスク検出\n期日リマインド"),
            ],
          },
        ],
      },
      footer: {
        type: "box", layout: "vertical",
        backgroundColor: "#1a1a2e",
        paddingAll: "14px",
        contents: [{
          type: "text", text: "🎉 7日間無料でお試しいただけます",
          color: "#ffffff", size: "sm", align: "center", weight: "bold",
        }],
      },
    },
  };

  // ── 2通目：チャット風の使い方例 ──
  const usageFlex = {
    type: "flex",
    altText: "こんなふうに話しかけてください",
    contents: {
      type: "bubble",
      size: "giga",
      header: {
        type: "box", layout: "vertical",
        backgroundColor: "#2c3e50",
        paddingAll: "20px",
        contents: [{
          type: "text", text: "💬 こんなふうに話しかけてください",
          color: "#ffffff", weight: "bold", size: "md",
        }],
      },
      body: {
        type: "box", layout: "vertical",
        backgroundColor: "#e8e8e8",
        paddingAll: "16px",
        spacing: "lg",
        contents: [
          // 例①
          { type: "box", layout: "vertical", spacing: "sm",
            contents: [
              chatBubble("right", "急ぎのメールある？"),
              chatBubble("left", "🔴 急ぎ1件\n田中部長「企画書の承認をお願いします」\n\n返信案を作りましょうか？"),
            ],
          },
          { type: "separator" },
          // 例②
          { type: "box", layout: "vertical", spacing: "sm",
            contents: [
              chatBubble("right", "来週火曜午後3時に鈴木さんとMTG入れて"),
              chatBubble("left", "📅 登録しました✅\n\n火曜 15:00〜16:00\n「鈴木さんとMTG」"),
            ],
          },
          { type: "separator" },
          // 例③
          { type: "box", layout: "vertical", spacing: "sm",
            contents: [
              chatBubble("right", "今日の予定は？"),
              chatBubble("left", "📋 今日の予定（3件）\n\n09:00 朝会\n13:00 ランチ@丸の内\n17:00 週次レビュー"),
            ],
          },
        ],
      },
    },
  };

  // ── 3通目：セットアップ案内 ──
  const setupFlex = {
    type: "flex",
    altText: "Googleアカウントを連携してはじめましょう",
    contents: {
      type: "bubble",
      size: "giga",
      header: {
        type: "box", layout: "vertical",
        backgroundColor: "#34a853",
        paddingAll: "20px",
        contents: [{
          type: "text", text: "🔗 セットアップ",
          color: "#ffffff", weight: "bold", size: "lg",
        }],
      },
      body: {
        type: "box", layout: "vertical",
        paddingAll: "20px",
        spacing: "lg",
        contents: [
          // STEP 1
          { type: "box", layout: "horizontal", spacing: "md",
            contents: [
              { type: "box", layout: "vertical", width: "28px", height: "28px",
                backgroundColor: "#34a853", cornerRadius: "14px",
                justifyContent: "center", alignItems: "center",
                contents: [{ type: "text", text: "✓", color: "#ffffff", size: "xs", align: "center" }],
              },
              { type: "box", layout: "vertical", flex: 1,
                contents: [
                  { type: "text", text: "STEP 1  LINE友達追加", weight: "bold", size: "sm", color: "#999999",
                    decoration: "line-through" },
                ],
              },
            ],
          },
          // STEP 2
          { type: "box", layout: "horizontal", spacing: "md",
            contents: [
              { type: "box", layout: "vertical", width: "28px", height: "28px",
                backgroundColor: "#34a853", cornerRadius: "14px",
                justifyContent: "center", alignItems: "center",
                contents: [{ type: "text", text: "2", color: "#ffffff", size: "xs", weight: "bold", align: "center" }],
              },
              { type: "box", layout: "vertical", flex: 1, spacing: "xs",
                contents: [
                  { type: "text", text: "STEP 2  Googleアカウント連携", weight: "bold", size: "sm", color: "#34a853" },
                  { type: "text", text: "← 今ここ！下のボタンから連携できます", size: "xs", color: "#34a853" },
                ],
              },
            ],
          },
          // STEP 3
          { type: "box", layout: "horizontal", spacing: "md",
            contents: [
              { type: "box", layout: "vertical", width: "28px", height: "28px",
                backgroundColor: "#dddddd", cornerRadius: "14px",
                justifyContent: "center", alignItems: "center",
                contents: [{ type: "text", text: "3", color: "#ffffff", size: "xs", weight: "bold", align: "center" }],
              },
              { type: "box", layout: "vertical", flex: 1,
                contents: [
                  { type: "text", text: "STEP 3  「今日の予定は？」で開始！", weight: "bold", size: "sm", color: "#aaaaaa" },
                ],
              },
            ],
          },
          { type: "separator" },
          // セキュリティ説明
          { type: "box", layout: "vertical",
            backgroundColor: "#f5f5f5", cornerRadius: "8px", paddingAll: "12px",
            spacing: "xs",
            contents: [
              { type: "text", text: "🔒 セキュリティについて", size: "xs", weight: "bold" },
              { type: "text", text: "・OAuth認証のみ使用（パスワードは取得しません）\n・アクセスするのはGmail・Calendarのみ\n・複数アカウントにも後から対応できます",
                size: "xxs", color: "#666666", wrap: true },
            ],
          },
        ],
      },
      footer: {
        type: "box", layout: "vertical",
        paddingAll: "16px",
        contents: [{
          type: "button", style: "primary", color: "#34a853", height: "md",
          action: { type: "uri", label: "Googleアカウントを連携する", uri: authUrl },
        }],
      },
    },
  };

  // ── 4通目：注意事項テキスト ──
  const notice = {
    type: "text",
    text: [
      "📋 ご利用プランについて",
      "",
      "Trial（7日間無料）… 全機能をお試し",
      "Light（月480円）… ブリーフィング＋メール通知",
      "Pro （月980円）… 全機能＋自由な対話",
      "",
      "⚠️ 現在α版のため、決済機能は準備中です。",
      "トライアル終了後のご案内は別途お送りします。",
      "",
      "ご意見・不具合はいつでもこのLINEに送ってください！",
      "",
      "【αテスト参加方法】",
      "まずこのLINEにあなたのGmailアドレスを送ってください。",
      "登録後にGoogle連携用のリンクをお送りします。",
    ].join("\n"),
  };

  return [introFlex, usageFlex, setupFlex, notice];
}

// ── コスト最適化 ──
// simple_command: Sonnet不使用、コード処理のみ（約0.04円/回）
// complex_request: Sonnet + Tool Use（約1.5〜4.5円/回）
// ループ最大3回でコスト上限設定

// ── NODE_ENV別動作 ──
// development:
//   simple_command → モックデータで固定処理
//   complex_request → Sonnet呼び出し（Gmail/Calendar APIはモック）
// production:
//   simple_command → 実データで固定処理
//   complex_request → Sonnet呼び出し（実データ）

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

  // Gmailアドレスを送ってきた場合 → テストユーザー登録フロー
  const emailMatch = text.match(/^[\w.+-]+@[\w-]+\.[\w.]+$/);
  if (emailMatch) {
    const email = emailMatch[0];
    const adminUrl = process.env["ADMIN_SERVER_URL"] ?? "";
    const adminSecret = process.env["ADMIN_SECRET"] ?? "";

    await client.replyMessage({
      replyToken: messageEvent.replyToken,
      messages: [{ type: "text", text: `\uD83D\uDCE7 ${email} \u3092\u78BA\u8A8D\u3057\u307E\u3057\u305F\u3002\u767B\u9332\u51E6\u7406\u4E2D\u3067\u3059...` }],
    });

    try {
      const res = await fetch(`${adminUrl}/add-test-user`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-admin-secret": adminSecret,
        },
        body: JSON.stringify({ email, userId }),
      });
      if (!res.ok) throw new Error(`Admin server error: ${res.status}`);
    } catch (err) {
      console.error("[webhook] admin server error:", err);
      await client.pushMessage({
        to: userId,
        messages: [{ type: "text", text: "\u767B\u9332\u306B\u5931\u6557\u3057\u307E\u3057\u305F\u3002\u7BA1\u7406\u8005\u306B\u9023\u7D61\u3057\u3066\u304F\u3060\u3055\u3044\u3002" }],
      });
    }
    return;
  }

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
        messages: [{ type: "text", text: "保留にしました。「保留メール見せて」で確認できます。" }],
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

  // secretary エージェントに全委譲
  // 3秒ルール: まず確認中を返してからバックグラウンドで処理
  await client.replyMessage({
    replyToken: messageEvent.replyToken,
    messages: [{ type: "text", text: "確認中..." }],
  });

  try {
    const response = await handleWithSecretary(userId, text);
    await client.pushMessage({
      to: userId,
      messages: [{ type: "text", text: response }],
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error("[webhook] secretary error:", err);
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
        const messages = buildWelcomeMessages(userId, authUrl);
        // LINE push は1回5通まで。4通なのでまとめて送信
        await client.pushMessage({ to: userId, messages });
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
