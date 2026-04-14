import { serve } from "@hono/node-server";
import { Hono } from "hono";
import "dotenv/config";
import { readFileSync, mkdirSync } from "fs";
import { join, dirname } from "path";
import { initDb, getUser } from "./db/queries.js";
import { webhook } from "./handlers/webhook.js";
import { runAgent } from "./agent/index.js";
import { auth } from "./integrations/auth.js";
import { startBriefing } from "./cron/briefing.js";
import { startTimerCron } from "./cron/timer.js";
import { startEmailWatchCron } from "./cron/emailWatch.js";
import { startReminderCron } from "./cron/reminders.js";
import { stripeWebhook } from "./handlers/stripe.js";
import { admin } from "./handlers/admin.js";

const app = new Hono();

// DB_PATHのディレクトリを事前に作成（永続ボリューム対応）
const dbPath = process.env["DB_PATH"] ?? "./data/secretary.db";
mkdirSync(dirname(dbPath), { recursive: true });

// DB初期化
initDb();

// cron起動
startBriefing();
startTimerCron();
startEmailWatchCron();
startReminderCron();

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

// プライバシーポリシー
app.get("/privacy", (c) => {
  const html = readFileSync(join(process.cwd(), "public/privacy.html"), "utf-8");
  return c.html(html);
});

// プライバシーポリシー（Google OAuth審査用詳細版・日英併記）
app.get("/privacy-policy", (c) => {
  const html = readFileSync(join(process.cwd(), "public/privacy-policy.html"), "utf-8");
  return c.html(html);
});

// 利用規約
app.get("/terms", (c) => {
  const html = readFileSync(join(process.cwd(), "public/terms.html"), "utf-8");
  return c.html(html);
});

// テストエンドポイント（LINE署名検証なしでエージェントを直接呼び出す）
app.post("/test", async (c) => {
  if (process.env["ENABLE_TEST_ENDPOINT"] !== "true") {
    return c.notFound();
  }

  let body: { userId?: string; message?: string };
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "Invalid JSON" }, 400);
  }

  const { userId, message } = body;
  if (!userId || !message) {
    return c.json({ error: "userId and message are required" }, 400);
  }

  try {
    const user = getUser(userId);
    const userName = user?.displayName ?? "テストユーザー";

    const response = await Promise.race([
      runAgent(userId, message, userName),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error("タイムアウト（30秒）")), 30_000),
      ),
    ]);

    return c.json({
      response,
      userId,
      message,
      timestamp: new Date().toISOString(),
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error("[test] agent error:", err);
    return c.json({ error: msg }, 500);
  }
});

// LINE Webhook
app.route("/", webhook);

// Google OAuth2
app.route("/", auth);

// Stripe Webhook
app.route("/", stripeWebhook);

// 管理画面
app.route("/", admin);

// 決済完了/キャンセルの単純ページ（Stripe Checkout の成功/キャンセル URL）
app.get("/billing/success", (c) => c.html(`<!DOCTYPE html><html lang="ja"><body style="font-family:sans-serif;text-align:center;padding:60px;"><h1>ご登録ありがとうございます🎉</h1><p>このページを閉じて、LINEに戻ってください。</p></body></html>`));
app.get("/billing/cancel", (c) => c.html(`<!DOCTYPE html><html lang="ja"><body style="font-family:sans-serif;text-align:center;padding:60px;"><h1>決済はキャンセルされました</h1><p>LINEに戻って、もう一度「プラン」と送ってください。</p></body></html>`));
app.get("/billing/portal-return", (c) => c.html(`<!DOCTYPE html><html lang="ja"><body style="font-family:sans-serif;text-align:center;padding:60px;"><h1>お手続き完了</h1><p>このページを閉じて、LINEに戻ってください。</p></body></html>`));

const port = Number(process.env["PORT"]) || 3000;
console.log(`Server running on http://localhost:${port}`);
serve({ fetch: app.fetch, port });
