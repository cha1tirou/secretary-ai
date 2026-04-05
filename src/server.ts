import { serve } from "@hono/node-server";
import { Hono } from "hono";
import "dotenv/config";
import { readFileSync } from "fs";
import { join } from "path";
import { initDb } from "./db/queries.js";
import { webhook } from "./handlers/webhook.js";
import { auth } from "./integrations/auth.js";
import { startCron } from "./cron/morning.js";
import { startAutoDraft } from "./cron/auto-draft.js";
import { dashboard } from "./routes/dashboard.js";

const app = new Hono();

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

// LINE Webhook
app.route("/", webhook);

// Google OAuth2
app.route("/", auth);

// Dashboard
app.route("/", dashboard);

const port = Number(process.env["PORT"]) || 3000;
console.log(`Server running on http://localhost:${port}`);
serve({ fetch: app.fetch, port });

