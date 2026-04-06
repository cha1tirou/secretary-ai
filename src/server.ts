import { serve } from "@hono/node-server";
import { Hono } from "hono";
import "dotenv/config";
import { readFileSync, mkdirSync } from "fs";
import { join, dirname } from "path";
import { initDb } from "./db/queries.js";
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

// 一時管理エンドポイント（使用後に削除予定）
app.post("/admin/clear-cache", async (c) => {
  const secret = c.req.query("secret");
  if (secret !== "secretary-admin-2026") return c.text("forbidden", 403);
  const { getDb } = await import("./db/queries.js");
  const db = getDb();
  const result = db.prepare("DELETE FROM email_cache").run();
  return c.json({ deleted: result.changes });
});

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

