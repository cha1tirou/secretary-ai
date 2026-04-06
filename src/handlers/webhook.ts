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

function featureRow(icon: string, title: string, desc: string) {
  return {
    type: "box" as const, layout: "horizontal" as const, spacing: "md" as const,
    contents: [
      { type: "text" as const, text: icon, size: "xl" as const, flex: 0 },
      { type: "box" as const, layout: "vertical" as const, flex: 1,
        contents: [
          { type: "text" as const, text: title, weight: "bold" as const, size: "sm" as const },
          { type: "text" as const, text: desc, size: "xs" as const, color: "#888888", wrap: true },
        ],
      },
    ],
  };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function buildWelcomeMessages(authUrl: string): { batch1: any[]; batch2: any[] } {
  // ── 1通目: introFlex（全体紹介） ──
  const introFlex = {
    type: "flex",
    altText: "AI\u79D8\u66F8\u3078\u3088\u3046\u3053\u305D\uFF01",
    contents: {
      type: "bubble", size: "giga",
      header: {
        type: "box", layout: "vertical", backgroundColor: "#1a1a2e", paddingAll: "20px",
        contents: [{ type: "text", text: "\uD83E\uDD16 AI\u79D8\u66F8\u3078\u3088\u3046\u3053\u305D\uFF01", color: "#ffffff", weight: "bold", size: "xl" }],
      },
      body: {
        type: "box", layout: "vertical", paddingAll: "20px", spacing: "lg",
        contents: [
          featureRow("\uD83D\uDD14", "\u81EA\u52D5\u304A\u77E5\u3089\u305B", "\u5927\u4E8B\u306A\u3053\u3068\u3092\u5148\u56DE\u308A\u3057\u3066\u5C4A\u3051\u307E\u3059"),
          featureRow("\uD83D\uDCEC", "\u30E1\u30FC\u30EB\u6574\u7406", "\u8FD4\u4FE1\u30FB\u50AC\u4FC3\u3092AI\u3068\u4E00\u7DD2\u306B\u7247\u4ED8\u3051\u308B"),
          featureRow("\uD83D\uDCAC", "\u8A71\u3057\u304B\u3051\u308B\u3060\u3051", "\u30E1\u30FC\u30EB\u691C\u7D22\u304B\u3089\u4E88\u5B9A\u767B\u9332\u307E\u3067\u5373\u5BFE\u5FDC"),
        ],
      },
      footer: {
        type: "box", layout: "vertical", backgroundColor: "#1a1a2e", paddingAll: "14px",
        contents: [{ type: "text", text: "\uD83C\uDF89 7\u65E5\u9593\u3001\u5168\u6A5F\u80FD\u3092\u7121\u6599\u3067\u304A\u8A66\u3057\u3044\u305F\u3060\u3051\u307E\u3059", color: "#ffffff", size: "sm", align: "center", weight: "bold" }],
      },
    },
  };

  // ── 2通目: pushFlex（Push詳細） ──
  const pushFlex = {
    type: "flex",
    altText: "\u81EA\u52D5\u304A\u77E5\u3089\u305B \u2014 \u5927\u4E8B\u306A\u3053\u3068\u3092\u5148\u56DE\u308A\u3057\u3066\u5C4A\u3051\u307E\u3059",
    contents: {
      type: "bubble", size: "giga",
      header: {
        type: "box", layout: "vertical", backgroundColor: "#2c3e50", paddingAll: "20px",
        contents: [{ type: "text", text: "\uD83D\uDD14 \u81EA\u52D5\u304A\u77E5\u3089\u305B \u2014 \u5927\u4E8B\u306A\u3053\u3068\u3092\u5148\u56DE\u308A\u3057\u3066\u5C4A\u3051\u307E\u3059", color: "#ffffff", weight: "bold", size: "md", wrap: true }],
      },
      body: {
        type: "box", layout: "vertical", paddingAll: "20px", spacing: "md",
        contents: [
          { type: "text", text: "\u671D\u30FB\u6627\u30FB\u591C\u306B\u30D6\u30EA\u30FC\u30D5\u30A3\u30F3\u30B0\u3092\u304A\u5C4A\u3051\u3057\u307E\u3059\u3002\u91CD\u8981\u306A\u30E1\u30FC\u30EB\u304C\u5C4A\u3044\u305F\u3089\u5373\u5EA7\u306B\u304A\u77E5\u3089\u305B\u3057\u307E\u3059\u3002", size: "sm", color: "#555555", wrap: true },
          { type: "box", layout: "vertical", backgroundColor: "#f0f0f0", cornerRadius: "8px", paddingAll: "14px",
            contents: [{ type: "text", size: "xs", color: "#333333", wrap: true,
              text: "\u3010\u671D\u306E\u30D6\u30EA\u30FC\u30D5\u30A3\u30F3\u30B0\u4F8B\u3011\n\u2602\uFE0F \u4ECA\u65E5\u306F\u5348\u5F8C\u304B\u3089\u96E8\u3001\u50B5\u3092\u304A\u5FD8\u308C\u306A\u304F\n\n\u2501\u2501 \u4ECA\u65E5\u306E\u4E88\u5B9A \u2501\u2501\n\u30FB10:00 \u9031\u6B21MTG\n\u30FB18:30 \u4F1A\u98DF\uFF08\u9280\u5EA7\uFF09\u2190 17:50\u51FA\u767A\u63A8\u5968\n\n\u2501\u2501 \u6C17\u306B\u306A\u308B\u3053\u3068 \u2501\u2501\n\u26A0\uFE0F ABC\u793E\u300C\u5951\u7D04\u66F8\u300D\u671F\u65E5\u304C\u4ECA\u65E5\n\u26A0\uFE0F \u5C71\u7530\u3055\u3093\u3078\u306E\u8FD4\u4FE1\u304C3\u65E5\u7D4C\u904E",
            }],
          },
        ],
      },
    },
  };

  // ── 3通目: mailFlex（メール処理詳細） ──
  const mailFlex = {
    type: "flex",
    altText: "\u30E1\u30FC\u30EB\u51E6\u7406 \u2014 AI\u304C\u304A\u624B\u4F1D\u3044",
    contents: {
      type: "bubble", size: "giga",
      header: {
        type: "box", layout: "vertical", backgroundColor: "#e67e22", paddingAll: "20px",
        contents: [{ type: "text", text: "\uD83D\uDCEC \u30E1\u30FC\u30EB\u6574\u7406 \u2014 \u8FD4\u4FE1\u30FB\u50AC\u4FC3\u3092AI\u3068\u4E00\u7DD2\u306B\u7247\u4ED8\u3051\u308B", color: "#ffffff", weight: "bold", size: "md", wrap: true }],
      },
      body: {
        type: "box", layout: "vertical", paddingAll: "20px", spacing: "md",
        contents: [
          { type: "text", text: "\u8FD4\u4FE1\u3057\u305F\u65B9\u304C\u3044\u3044\u30E1\u30FC\u30EB\u3092\u4E26\u3079\u3066\u3001AI\u304C\u8FD4\u4FE1\u3092\u304A\u624B\u4F1D\u3044\u3057\u307E\u3059\u3002", size: "sm", color: "#555555", wrap: true },
          { type: "text", text: "\u3010\u8FD4\u4FE1\u306E3\u629E\u3011\n\u2460 AI\u304C\u8FD4\u4FE1\u6848\u3092\u4F5C\u308B\n\u2461 \u8981\u70B9\u3092\u4F1D\u3048\u3066AI\u304C\u6E05\u66F8\u3059\u308B\n\u2462 \u5F8C\u3067\u5BFE\u5FDC\u3059\u308B", size: "sm", color: "#333333", wrap: true },
          { type: "text", text: "\u9001\u4FE1\u3057\u305F\u306E\u306B\u8FD4\u4FE1\u304C\u6765\u3066\u3044\u306A\u3044\u30E1\u30FC\u30EB\u3082\u691C\u77E5\u3057\u3066\u300C\u50AC\u4FC3\u3057\u307E\u3057\u3087\u3046\u304B\uFF1F\u300D\u3068\u63D0\u6848\u3057\u307E\u3059\u3002", size: "xs", color: "#888888", wrap: true },
          { type: "text", text: "\u51E6\u7406\u306F\u30C0\u30C3\u30B7\u30E5\u30DC\u30FC\u30C9\u304B\u3089\uFF08Google\u8A8D\u8A3C\u5F8C\u306B\u500B\u4EBA\u7528URL\u3092\u304A\u9001\u308A\u3057\u307E\u3059\uFF09", size: "xs", color: "#aaaaaa", wrap: true },
        ],
      },
    },
  };

  // ── 4通目: pullFlex（Pull詳細） ──
  const pullFlex = {
    type: "flex",
    altText: "Pull \u2014 \u30E1\u30FC\u30EB\u30FB\u4E88\u5B9A\u3092\u67D4\u8EDF\u306B\u691C\u7D22\u30FB\u767B\u9332",
    contents: {
      type: "bubble", size: "giga",
      header: {
        type: "box", layout: "vertical", backgroundColor: "#8e44ad", paddingAll: "20px",
        contents: [{ type: "text", text: "\uD83D\uDCAC \u8A71\u3057\u304B\u3051\u308B\u3060\u3051 \u2014 \u691C\u7D22\u30FB\u767B\u9332\u30FB\u78BA\u8A8D\u3092LINE\u3067\u5B8C\u7D50", color: "#ffffff", weight: "bold", size: "md", wrap: true }],
      },
      body: {
        type: "box", layout: "vertical", paddingAll: "20px", spacing: "md",
        contents: [
          { type: "text", text: "LINE\u3067\u8A71\u3057\u304B\u3051\u308B\u3060\u3051\u3067\u3001\u30E1\u30FC\u30EB\u3084\u4E88\u5B9A\u3092\u3059\u3050\u306B\u691C\u7D22\u30FB\u64CD\u4F5C\u3067\u304D\u307E\u3059\u3002", size: "sm", color: "#555555", wrap: true },
          { type: "text", text: "\u3010\u4F7F\u3044\u65B9\u4F8B\u3011\n\u30FB\u300C\u5C71\u7530\u3055\u3093\u304B\u3089\u30E1\u30FC\u30EB\u6765\u3066\u308B\uFF1F\u300D\u2192 \u5373\u691C\u7D22\n\u30FB\u300C\u6765\u9031\u306E\u7A7A\u304D\u6642\u9593\u3092\u6559\u3048\u3066\u300D\u2192 \u30AB\u30EC\u30F3\u30C0\u30FC\u3092\u78BA\u8A8D\n\u30FB\u300C\u706B\u66DC\u5348\u5F8C3\u6642\u306B\u9234\u6728\u3055\u3093\u3068MTG\u5165\u308C\u3066\u300D\u2192 \u81EA\u52D5\u767B\u9332\n\u30FB\u300C\u8FD4\u4FE1\u3059\u3079\u304D\u30E1\u30FC\u30EB\u3042\u308B\uFF1F\u300D\u2192 \u4E00\u89A7\u8868\u793A\n\u30FB\u300C\u30BF\u30B9\u30AF\u306B\u25CB\u25CB\u3092\u8FFD\u52A0\u3057\u3066\u300D\u2192 \u30BF\u30B9\u30AF\u30EA\u30B9\u30C8\u306B\u767B\u9332", size: "sm", color: "#333333", wrap: true },
          { type: "text", text: "\u30E1\u30FC\u30EB\u691C\u7D22\u30FB\u65E5\u7A0B\u8ABF\u6574\u30FB\u30AB\u30EC\u30F3\u30C0\u30FC\u767B\u9332\u30FB\u30BF\u30B9\u30AF\u7BA1\u7406\u306A\u3069\u3001\u67D4\u8EDF\u306B\u5BFE\u5FDC\u3057\u307E\u3059\u3002", size: "xs", color: "#888888", wrap: true },
        ],
      },
    },
  };

  // ── 5通目: setupFlex（セットアップ） ──
  const setupFlex = {
    type: "flex",
    altText: "Google\u30A2\u30AB\u30A6\u30F3\u30C8\u3092\u9023\u643A\u3057\u3066\u306F\u3058\u3081\u307E\u3057\u3087\u3046",
    contents: {
      type: "bubble", size: "giga",
      header: {
        type: "box", layout: "vertical", backgroundColor: "#34a853", paddingAll: "20px",
        contents: [{ type: "text", text: "\uD83D\uDD17 \u30BB\u30C3\u30C8\u30A2\u30C3\u30D7", color: "#ffffff", weight: "bold", size: "lg" }],
      },
      body: {
        type: "box", layout: "vertical", paddingAll: "20px", spacing: "lg",
        contents: [
          { type: "box", layout: "horizontal", spacing: "md",
            contents: [
              { type: "box", layout: "vertical", width: "28px", height: "28px", backgroundColor: "#34a853", cornerRadius: "14px", justifyContent: "center", alignItems: "center",
                contents: [{ type: "text", text: "\u2713", color: "#ffffff", size: "xs", align: "center" }] },
              { type: "box", layout: "vertical", flex: 1,
                contents: [{ type: "text", text: "STEP 1  LINE\u53CB\u9054\u8FFD\u52A0", weight: "bold", size: "sm", color: "#999999", decoration: "line-through" }] },
            ],
          },
          { type: "box", layout: "horizontal", spacing: "md",
            contents: [
              { type: "box", layout: "vertical", width: "28px", height: "28px", backgroundColor: "#34a853", cornerRadius: "14px", justifyContent: "center", alignItems: "center",
                contents: [{ type: "text", text: "2", color: "#ffffff", size: "xs", weight: "bold", align: "center" }] },
              { type: "box", layout: "vertical", flex: 1, spacing: "xs",
                contents: [
                  { type: "text", text: "STEP 2  Google\u30A2\u30AB\u30A6\u30F3\u30C8\u9023\u643A", weight: "bold", size: "sm", color: "#34a853" },
                  { type: "text", text: "\u2190 \u4ECA\u3053\u3053\uFF01\u4E0B\u306E\u30DC\u30BF\u30F3\u304B\u3089\u9023\u643A\u3067\u304D\u307E\u3059", size: "xs", color: "#34a853" },
                ] },
            ],
          },
          { type: "box", layout: "horizontal", spacing: "md",
            contents: [
              { type: "box", layout: "vertical", width: "28px", height: "28px", backgroundColor: "#dddddd", cornerRadius: "14px", justifyContent: "center", alignItems: "center",
                contents: [{ type: "text", text: "3", color: "#ffffff", size: "xs", weight: "bold", align: "center" }] },
              { type: "box", layout: "vertical", flex: 1,
                contents: [{ type: "text", text: "STEP 3  \u300C\u4ECA\u65E5\u306E\u4E88\u5B9A\u306F\uFF1F\u300D\u3067\u958B\u59CB\uFF01", weight: "bold", size: "sm", color: "#aaaaaa" }] },
            ],
          },
          { type: "separator" },
          { type: "box", layout: "vertical", backgroundColor: "#f5f5f5", cornerRadius: "8px", paddingAll: "12px", spacing: "xs",
            contents: [
              { type: "text", text: "\uD83D\uDD12 \u30BB\u30AD\u30E5\u30EA\u30C6\u30A3\u306B\u3064\u3044\u3066", size: "xs", weight: "bold" },
              { type: "text", text: "\u30FBOAUTH\u8A8D\u8A3C\u306E\u307F\u4F7F\u7528\uFF08\u30D1\u30B9\u30EF\u30FC\u30C9\u306F\u53D6\u5F97\u3057\u307E\u305B\u3093\uFF09\n\u30FB\u30A2\u30AF\u30BB\u30B9\u3059\u308B\u306E\u306FGmail\u30FBCalendar\u306E\u307F\n\u30FB\u8907\u6570\u30A2\u30AB\u30A6\u30F3\u30C8\u306B\u3082\u5F8C\u304B\u3089\u5BFE\u5FDC\u3067\u304D\u307E\u3059", size: "xxs", color: "#666666", wrap: true },
            ],
          },
        ],
      },
      footer: {
        type: "box", layout: "vertical", paddingAll: "16px",
        contents: [{ type: "button", style: "primary", color: "#34a853", height: "md",
          action: { type: "uri", label: "Google\u30A2\u30AB\u30A6\u30F3\u30C8\u3092\u9023\u643A\u3059\u308B", uri: authUrl } }],
      },
    },
  };

  // ── 6通目: notice（注意事項テキスト） ──
  const notice = {
    type: "text",
    text: [
      "\uD83D\uDCCB \u3054\u5229\u7528\u30D7\u30E9\u30F3\u306B\u3064\u3044\u3066",
      "",
      "Trial\uFF087\u65E5\u9593\u7121\u6599\uFF09",
      "\u30FB30\u30AF\u30EC\u30B8\u30C3\u30C8/\u6708",
      "",
      "Light\uFF08\u6708480\u5186\uFF09",
      "\u30FB100\u30AF\u30EC\u30B8\u30C3\u30C8/\u6708",
      "",
      "Pro\uFF08\u6708980\u5186\uFF09",
      "\u30FB300\u30AF\u30EC\u30B8\u30C3\u30C8/\u6708",
      "",
      "\u30AF\u30EC\u30B8\u30C3\u30C8\u306FAI\u8FD4\u4FE1\u751F\u6210\u30FBAI\u5BFE\u8A71\u306A\u3069\u306E",
      "AI\u6A5F\u80FD\u3092\u4F7F\u7528\u3059\u308B\u3054\u3068\u306B\u6D88\u8CBB\u3055\u308C\u307E\u3059\u3002",
      "\u6BCE\u67081\u65E5\u306B\u30EA\u30BB\u30C3\u30C8\u3055\u308C\u307E\u3059\u3002",
      "",
      "\u26A0\uFE0F \u73FE\u5728\u03B1\u7248\u306E\u305F\u3081\u6C7A\u6E08\u6A5F\u80FD\u306F\u6E96\u5099\u4E2D\u3067\u3059\u3002",
      "\u30C8\u30E9\u30A4\u30A2\u30EB\u7D42\u4E86\u5F8C\u306E\u3054\u6848\u5185\u306F\u5225\u9014\u304A\u9001\u308A\u3057\u307E\u3059\u3002",
      "",
      "\u3054\u610F\u898B\u30FB\u4E0D\u5177\u5408\u306F\u3044\u3064\u3067\u3082\u3053\u306ELINE\u306B\u9001\u3063\u3066\u304F\u3060\u3055\u3044\uFF01",
    ].join("\n"),
  };

  return {
    batch1: [introFlex, pushFlex, mailFlex],
    batch2: [pullFlex, setupFlex, notice],
  };
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
        const { batch1, batch2 } = buildWelcomeMessages(authUrl);
        // LINE push は1回5通まで。6通なので2回に分けて送信
        await client.pushMessage({ to: userId, messages: batch1 });
        await client.pushMessage({ to: userId, messages: batch2 });
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
