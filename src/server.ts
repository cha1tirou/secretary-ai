import { serve } from "@hono/node-server";
import { Hono } from "hono";
import "dotenv/config";
import { readFileSync, mkdirSync } from "fs";
import { join, dirname } from "path";
import { initDb } from "./db/queries.js";
import { webhook } from "./handlers/webhook.js";
import { auth } from "./integrations/auth.js";

const app = new Hono();

// DB_PATHのディレクトリを事前に作成（永続ボリューム対応）
const dbPath = process.env["DB_PATH"] ?? "./data/secretary.db";
mkdirSync(dirname(dbPath), { recursive: true });

// DB初期化
initDb();

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

// 利用規約
app.get("/terms", (c) => {
  const html = readFileSync(join(process.cwd(), "public/terms.html"), "utf-8");
  return c.html(html);
});

// LINE Webhook
app.route("/", webhook);

// Google OAuth2
app.route("/", auth);

const port = Number(process.env["PORT"]) || 3000;
console.log(`Server running on http://localhost:${port}`);
serve({ fetch: app.fetch, port });
