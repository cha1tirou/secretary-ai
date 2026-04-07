import { serve } from "@hono/node-server";
import { Hono } from "hono";
import "dotenv/config";
import { readFileSync, mkdirSync } from "fs";
import { join, dirname } from "path";
import { initDb, createWaitlistEntry, getWaitlistByEmail } from "./db/queries.js";
import { webhook } from "./handlers/webhook.js";
import { auth } from "./integrations/auth.js";
import { startCron } from "./cron/morning.js";
import { startAutoDraft } from "./cron/auto-draft.js";
import { dashboard } from "./routes/dashboard.js";

const app = new Hono();

// DB_PATHのディレクトリを事前に作成（永続ボリューム対応）
const dbPath = process.env["DB_PATH"] ?? "./data/secretary.db";
mkdirSync(dirname(dbPath), { recursive: true });

// DB初期化
initDb();

// Cron起動
startCron();
startAutoDraft();

// ヘルスチェック
app.get("/health", (c) => c.json({ status: "ok" }));


// LP（ランディングページ）
app.get("/", (c) => {
  try {
    const html = readFileSync(join(process.cwd(), "public/index.html"), "utf-8");
    return c.html(html);
  } catch {
    return c.text("AI秘書 - Coming Soon");
  }
});

// \u7533\u3057\u8FBC\u307F\u30D5\u30A9\u30FC\u30E0
app.post("/apply", async (c) => {
  try {
    const body = await c.req.parseBody();
    const name = ((body["name"] as string) ?? "").trim();
    const email = ((body["email"] as string) ?? "").trim().toLowerCase();

    if (!name || !email || !email.includes("@")) {
      return c.json({ ok: false, error: "\u540D\u524D\u3068Gmail\u30A2\u30C9\u30EC\u30B9\u3092\u6B63\u3057\u304F\u5165\u529B\u3057\u3066\u304F\u3060\u3055\u3044" }, 400);
    }

    const existing = getWaitlistByEmail(email);
    if (existing) {
      if (existing.status === "approved") return c.json({ ok: false, error: "already_approved" });
      return c.json({ ok: false, error: "already_registered" });
    }

    createWaitlistEntry(name, email);

    const adminUserId = process.env["ADMIN_LINE_USER_ID"];
    if (adminUserId) {
      const { messagingApi } = await import("@line/bot-sdk");
      const client = new messagingApi.MessagingApiClient({
        channelAccessToken: process.env["LINE_CHANNEL_ACCESS_TOKEN"] ?? "",
      });
      await client.pushMessage({
        to: adminUserId,
        messages: [{
          type: "text",
          text: `\uD83D\uDCDD \u65B0\u898F\u7533\u8FBC\u304C\u3042\u308A\u307E\u3057\u305F\n\n\u540D\u524D: ${name}\nEmail: ${email}\n\nGoogle Console\u306B\u30C6\u30B9\u30C8\u30E6\u30FC\u30B6\u30FC\u3068\u3057\u3066\u8FFD\u52A0\u5F8C\u3001\n\u300C\u627F\u8A8D ${email}\u300D\u3068\u9001\u3063\u3066\u304F\u3060\u3055\u3044\u3002`,
        }],
      }).catch((err: unknown) => console.error("[apply] LINE notify error:", err));
    }

    return c.json({ ok: true });
  } catch (err) {
    console.error("[apply] error:", err);
    return c.json({ ok: false, error: "\u30B5\u30FC\u30D0\u30FC\u30A8\u30E9\u30FC\u304C\u767A\u751F\u3057\u307E\u3057\u305F" }, 500);
  }
});

// LINE Webhook
app.route("/", webhook);

// Google OAuth2
app.route("/", auth);

// Dashboard
app.route("/", dashboard);

const port = Number(process.env["PORT"]) || 3000;
console.log(`Server running on http://localhost:${port}`);
serve({ fetch: app.fetch, port });

