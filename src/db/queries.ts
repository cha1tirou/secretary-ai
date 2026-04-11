import Database from "better-sqlite3";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import type { User, GoogleAccount, PendingReply, BriefingItem, Plan } from "../types.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

let db: Database.Database;

// [PG] better-sqlite3 → pg or drizzle-orm/postgres-js に置換
// [PG] .prepare().run/get/all → クエリビルダーまたはprepared statement
// [PG] ? プレースホルダ → $1, $2 形式
// [PG] lastInsertRowid → RETURNING id
export function getDb(): Database.Database {
  if (!db) {
    const dbPath = process.env["DB_PATH"] || "./data/secretary.db";
    db = new Database(dbPath);
    db.pragma("journal_mode = WAL");   // [PG] 不要（PostgreSQLはデフォルトでWAL相当）
    db.pragma("foreign_keys = ON");    // [PG] 不要（デフォルトで有効）
  }
  return db;
}

export function initDb(): void {
  const d = getDb();
  const schema = readFileSync(resolve(__dirname, "schema.sql"), "utf-8");
  d.exec(schema);

  // [PG] PRAGMA → information_schema.columns で確認、またはマイグレーションツール使用
  // マイグレーション: processed_emails に category カラム追加
  const cols = d.prepare("PRAGMA table_info(processed_emails)").all() as { name: string }[];
  if (!cols.some((c) => c.name === "category")) {
    d.exec("ALTER TABLE processed_emails ADD COLUMN category TEXT DEFAULT 'other'");
  }

  // マイグレーション: users に plan カラム追加
  const userCols = d.prepare("PRAGMA table_info(users)").all() as { name: string }[];
  if (!userCols.some((c) => c.name === "plan")) {
    d.exec("ALTER TABLE users ADD COLUMN plan TEXT DEFAULT 'trial'");
    d.exec("ALTER TABLE users ADD COLUMN trial_start_date TEXT");
    d.exec("ALTER TABLE users ADD COLUMN plan_expires_at TEXT");
  }

  // [PG] ALTER TABLE ... DROP CONSTRAINT + ADD CONSTRAINT で CHECK変更可能
  // マイグレーション: pending_replies の status に 'hold' を許可
  // SQLite は CHECK 制約の変更不可なので、既存テーブルはそのまま（新規作成時のみ反映）

  // マイグレーション: メール分類カテゴリの変更 (reply_urgent→urgent_reply, important_info→action_needed, other→fyi)
  d.exec("UPDATE processed_emails SET category = 'urgent_reply' WHERE category = 'reply_urgent'");
  d.exec("UPDATE processed_emails SET category = 'action_needed' WHERE category = 'important_info'");
  d.exec("UPDATE processed_emails SET category = 'fyi' WHERE category = 'other'");

  // マイグレーション: users.gmail_token → google_accounts に移行
  const usersWithToken = d.prepare(
    "SELECT user_id, gmail_token, gcal_token FROM users WHERE gmail_token IS NOT NULL",
  ).all() as { user_id: string; gmail_token: string | null; gcal_token: string | null }[];
  for (const row of usersWithToken) {
    const existing = d.prepare(
      "SELECT 1 FROM google_accounts WHERE user_id = ? AND label = 'default'",
    ).get(row.user_id);
    if (!existing) {
      d.prepare(
        "INSERT INTO google_accounts (user_id, label, gmail_token, gcal_token) VALUES (?, 'default', ?, ?)",
      ).run(row.user_id, row.gmail_token, row.gcal_token);
    }
  }

  // マイグレーション: email_watch_rules に pattern2 カラム追加
  const watchCols = d.prepare("PRAGMA table_info(email_watch_rules)").all() as { name: string }[];
  if (watchCols.length > 0 && !watchCols.some((c) => c.name === "pattern2")) {
    d.exec("ALTER TABLE email_watch_rules ADD COLUMN pattern2 TEXT");
  }

  // 起動時にemail_cacheの古いエントリを削除（7日以上前）
  d.exec(`DELETE FROM email_cache WHERE cached_at < datetime('now', '-7 days', 'localtime')`);
}

// ── Users ──

export function upsertUser(
  userId: string,
  displayName?: string,
  plan?: Plan,
): void {
  getDb()
    .prepare(
      `INSERT INTO users (user_id, display_name, plan, trial_start_date)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(user_id) DO UPDATE SET
         display_name = COALESCE(excluded.display_name, display_name),
         updated_at = CURRENT_TIMESTAMP`,
    )
    .run(userId, displayName ?? null, plan ?? "trial", new Date().toISOString());
}

export function updateUserPlan(userId: string, plan: Plan): void {
  getDb()
    .prepare(
      "UPDATE users SET plan = ?, updated_at = CURRENT_TIMESTAMP WHERE user_id = ?",
    )
    .run(plan, userId);
}

export function getTrialDaysRemaining(userId: string): number {
  const user = getUser(userId);
  if (!user?.trialStartDate) return 7;
  const start = new Date(user.trialStartDate).getTime();
  const now = Date.now();
  const elapsed = Math.floor((now - start) / 86400000);
  return Math.max(0, 7 - elapsed);
}

export function getUser(userId: string): User | undefined {
  return getDb()
    .prepare(
      `SELECT
        user_id AS userId,
        display_name AS displayName,
        COALESCE(plan, 'trial') AS plan,
        trial_start_date AS trialStartDate,
        plan_expires_at AS planExpiresAt,
        gmail_token AS gmailToken,
        gcal_token AS gcalToken,
        writing_style AS writingStyle,
        briefing_hour AS briefingHour,
        created_at AS createdAt,
        updated_at AS updatedAt
      FROM users WHERE user_id = ?`,
    )
    .get(userId) as User | undefined;
}

export function updateUserTokens(
  userId: string,
  tokens: { gmailToken?: string | null; gcalToken?: string | null },
): void {
  if (tokens.gmailToken !== undefined) {
    getDb()
      .prepare(
        "UPDATE users SET gmail_token = ?, updated_at = CURRENT_TIMESTAMP WHERE user_id = ?",
      )
      .run(tokens.gmailToken, userId);
  }
  if (tokens.gcalToken !== undefined) {
    getDb()
      .prepare(
        "UPDATE users SET gcal_token = ?, updated_at = CURRENT_TIMESTAMP WHERE user_id = ?",
      )
      .run(tokens.gcalToken, userId);
  }
}

export function updateWritingStyle(userId: string, style: string): void {
  getDb()
    .prepare(
      "UPDATE users SET writing_style = ?, updated_at = CURRENT_TIMESTAMP WHERE user_id = ?",
    )
    .run(style, userId);
}

export function getAllUserIds(): string[] {
  const rows = getDb()
    .prepare("SELECT user_id FROM users")
    .all() as { user_id: string }[];
  return rows.map((r) => r.user_id);
}

/** Google連携済みの全ユーザーを返す */
export function getAllUsers(): { lineUserId: string; displayName: string | null }[] {
  return getDb()
    .prepare(
      `SELECT DISTINCT u.user_id AS lineUserId, u.display_name AS displayName
       FROM users u
       INNER JOIN google_accounts g ON u.user_id = g.user_id
       WHERE g.gmail_token IS NOT NULL`,
    )
    .all() as { lineUserId: string; displayName: string | null }[];
}

// ── Google Accounts ──

export function getGoogleAccountsByUserId(userId: string): GoogleAccount[] {
  return getDb()
    .prepare(
      `SELECT id, user_id AS userId, label, email, gmail_token AS gmailToken,
        gcal_token AS gcalToken, created_at AS createdAt
       FROM google_accounts WHERE user_id = ? ORDER BY created_at ASC`,
    )
    .all(userId) as GoogleAccount[];
}

export function upsertGoogleAccount(
  userId: string,
  label: string,
  email: string | null,
  gmailToken: string,
  gcalToken: string,
): void {
  getDb()
    .prepare(
      `INSERT INTO google_accounts (user_id, label, email, gmail_token, gcal_token)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(user_id, label) DO UPDATE SET
         email = excluded.email,
         gmail_token = excluded.gmail_token,
         gcal_token = excluded.gcal_token`,
    )
    .run(userId, label, email, gmailToken, gcalToken);
}

export function deleteGoogleAccountsByUserId(userId: string): void {
  getDb()
    .prepare("DELETE FROM google_accounts WHERE user_id = ?")
    .run(userId);
}

// ── Conversations ──

export function addConversation(
  userId: string,
  role: "user" | "assistant",
  content: string,
  intent?: string,
): void {
  getDb()
    .prepare(
      "INSERT INTO conversations (user_id, role, content, intent) VALUES (?, ?, ?, ?)",
    )
    .run(userId, role, content, intent ?? null);
}

export function getRecentConversations(
  userId: string,
  limit = 5,
): { role: "user" | "assistant"; content: string }[] {
  return getDb()
    .prepare(
      "SELECT role, content FROM conversations WHERE user_id = ? ORDER BY created_at DESC LIMIT ?",
    )
    .all(userId, limit)
    .reverse() as { role: "user" | "assistant"; content: string }[];
}

// ── Pending Replies ──

export function createPendingReply(params: {
  userId: string;
  threadId: string;
  toAddress: string;
  subject: string;
  draftContent: string;
}): number {
  const result = getDb()
    .prepare(
      `INSERT INTO pending_replies (user_id, thread_id, to_address, subject, draft_content)
       VALUES (?, ?, ?, ?, ?)`,
    )
    .run(
      params.userId,
      params.threadId,
      params.toAddress,
      params.subject,
      params.draftContent,
    );
  return Number(result.lastInsertRowid); // [PG] RETURNING id を使う
}

export function updatePendingReplyStatus(
  id: number,
  status: PendingReply["status"],
): void {
  const sentAt = status === "sent" ? new Date().toISOString() : null;
  getDb()
    .prepare(
      "UPDATE pending_replies SET status = ?, sent_at = COALESCE(?, sent_at) WHERE id = ?",
    )
    .run(status, sentAt, id);
}

// ── Processed Emails ──

export type EmailCategory = "urgent_reply" | "reply_later" | "action_needed" | "fyi" | "newsletter";

export function isEmailProcessed(messageId: string): boolean {
  const row = getDb()
    .prepare("SELECT 1 FROM processed_emails WHERE message_id = ?")
    .get(messageId);
  return row !== undefined;
}

export function markEmailProcessed(messageId: string, userId: string, category: EmailCategory = "fyi"): void {
  getDb()
    .prepare(
      "INSERT OR IGNORE INTO processed_emails (message_id, user_id, category) VALUES (?, ?, ?)", // [PG] INSERT ... ON CONFLICT DO NOTHING
    )
    .run(messageId, userId, category);
}

export function getProcessedEmailsByCategory(
  userId: string,
  category: EmailCategory,
  since?: string,
): { messageId: string; processedAt: string }[] {
  const query = since
    ? "SELECT message_id AS messageId, processed_at AS processedAt FROM processed_emails WHERE user_id = ? AND category = ? AND processed_at >= ?"
    : "SELECT message_id AS messageId, processed_at AS processedAt FROM processed_emails WHERE user_id = ? AND category = ?";
  const params = since ? [userId, category, since] : [userId, category];
  return getDb().prepare(query).all(...params) as { messageId: string; processedAt: string }[];
}

export function countProcessedEmailsByCategory(
  userId: string,
  category: EmailCategory,
  since?: string,
): number {
  const query = since
    ? "SELECT COUNT(*) AS cnt FROM processed_emails WHERE user_id = ? AND category = ? AND processed_at >= ?"
    : "SELECT COUNT(*) AS cnt FROM processed_emails WHERE user_id = ? AND category = ?";
  const params = since ? [userId, category, since] : [userId, category];
  const row = getDb().prepare(query).get(...params) as { cnt: number };
  return row.cnt;
}

export function getPendingRepliesByStatus(
  userId: string,
  status: PendingReply["status"],
): PendingReply[] {
  return getDb()
    .prepare(
      `SELECT
        id, user_id AS userId, thread_id AS threadId, to_address AS toAddress,
        subject, draft_content AS draftContent, status, created_at AS createdAt, sent_at AS sentAt
      FROM pending_replies WHERE user_id = ? AND status = ? ORDER BY created_at DESC`,
    )
    .all(userId, status) as PendingReply[];
}

export function getPendingReply(id: number): PendingReply | undefined {
  return getDb()
    .prepare(
      `SELECT
        id, user_id AS userId, thread_id AS threadId, to_address AS toAddress,
        subject, draft_content AS draftContent, status, created_at AS createdAt, sent_at AS sentAt
      FROM pending_replies WHERE id = ?`,
    )
    .get(id) as PendingReply | undefined;
}

// ── Monthly Send Count ──

const SEND_LIMITS: Record<string, number> = {
  trial: 5,
  free: 5,
  lite: 30,
  standard: 60,
  pro: 150,
};

export function getMonthlySendCount(userId: string): number {
  const now = new Date();
  const yearMonth = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;
  const row = getDb()
    .prepare("SELECT count FROM monthly_send_count WHERE user_id = ? AND year_month = ?")
    .get(userId, yearMonth) as { count: number } | undefined;
  return row?.count ?? 0;
}

export function incrementMonthlySendCount(userId: string): void {
  const now = new Date();
  const yearMonth = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;
  getDb()
    .prepare(
      `INSERT INTO monthly_send_count (user_id, year_month, count)
       VALUES (?, ?, 1)
       ON CONFLICT(user_id, year_month) DO UPDATE SET count = count + 1`,
    )
    .run(userId, yearMonth);
}

export function checkSendLimit(userId: string, plan: string): {
  allowed: boolean;
  used: number;
  limit: number;
} {
  const limit = SEND_LIMITS[plan] ?? SEND_LIMITS["free"]!;
  const used = getMonthlySendCount(userId);
  return { allowed: used < limit, used, limit };
}

// ── Timers ──

export function createTimer(lineUserId: string, fireAt: string, message: string): void {
  getDb()
    .prepare("INSERT INTO timers (line_user_id, fire_at, message) VALUES (?, ?, ?)")
    .run(lineUserId, fireAt, message);
}

export function getPendingTimers(): Array<{ id: number; lineUserId: string; fireAt: string; message: string }> {
  return getDb()
    .prepare(
      `SELECT id, line_user_id AS lineUserId, fire_at AS fireAt, message
       FROM timers WHERE done = 0 ORDER BY fire_at ASC`,
    )
    .all() as Array<{ id: number; lineUserId: string; fireAt: string; message: string }>;
}

export function markTimerDone(id: number): void {
  getDb().prepare("UPDATE timers SET done = 1 WHERE id = ?").run(id);
}

// ── Briefing Items ──

export function saveBriefingItems(lineUserId: string, items: BriefingItem[]): void {
  const stmt = getDb().prepare(
    `INSERT INTO briefing_items (line_user_id, number, email_id, thread_id, type, summary)
     VALUES (?, ?, ?, ?, ?, ?)`,
  );
  const insertMany = getDb().transaction((rows: BriefingItem[]) => {
    for (const item of rows) {
      stmt.run(lineUserId, item.number, item.emailId, item.threadId, item.type, item.summary);
    }
  });
  insertMany(items);
}

export function getBriefingItem(lineUserId: string, number: number): BriefingItem | null {
  const row = getDb()
    .prepare(
      `SELECT line_user_id AS lineUserId, number, email_id AS emailId,
              thread_id AS threadId, type, summary
       FROM briefing_items WHERE line_user_id = ? AND number = ?
       ORDER BY created_at DESC LIMIT 1`,
    )
    .get(lineUserId, number) as BriefingItem | undefined;
  return row ?? null;
}

export function clearBriefingItems(lineUserId: string): void {
  getDb().prepare("DELETE FROM briefing_items WHERE line_user_id = ?").run(lineUserId);
}

// ── Email Cache ──

export function getCachedEmailCategory(messageId: string, userId: string): string | null {
  const row = getDb().prepare(`
    SELECT category FROM email_cache
    WHERE message_id = ? AND user_id = ?
    AND cached_at >= datetime('now', '-7 days', 'localtime')
  `).get(messageId, userId) as { category: string } | undefined;
  return row?.category ?? null;
}

export function setCachedEmailCategory(messageId: string, userId: string, category: string): void {
  getDb().prepare(`
    INSERT OR REPLACE INTO email_cache (message_id, user_id, category, cached_at)
    VALUES (?, ?, ?, datetime('now', 'localtime'))
  `).run(messageId, userId, category);
}

// ── Usage Logs ──

export function getMonthlyUsage(userId: string, actionType: string): number {
  const row = getDb().prepare(`
    SELECT COUNT(*) as count FROM usage_logs
    WHERE user_id = ? AND action_type = ?
    AND created_at >= date('now', 'start of month', 'localtime')
  `).get(userId, actionType) as { count: number };
  return row.count;
}

export function logUsage(userId: string, actionType: string): void {
  getDb().prepare("INSERT INTO usage_logs (user_id, action_type) VALUES (?, ?)").run(userId, actionType);
}

export const USAGE_LIMITS: Record<string, Record<string, number>> = {
  trial:   { credit: 30 },
  light:   { credit: 100 },
  pro:     { credit: 300 },
  expired: { credit: 0 },
};

export function checkUsageLimit(
  userId: string,
  plan: string,
  actionType: string,
): { allowed: boolean; used: number; limit: number; remaining: number } {
  const limit = USAGE_LIMITS[plan]?.[actionType] ?? 0;
  const used = getMonthlyUsage(userId, actionType);
  const remaining = Math.max(0, limit - used);
  return { allowed: remaining > 0, used, limit, remaining };
}

export function getResetDate(): string {
  const d = new Date();
  d.setMonth(d.getMonth() + 1, 1);
  return `${d.getMonth() + 1}\u67081\u65E5`;
}

// ── Email Watch Rules ──

export function createEmailWatchRule(
  userId: string,
  matchType: "from" | "subject" | "keyword" | "from_and_keyword",
  pattern: string,
  description: string,
  pattern2?: string,
): number {
  const result = getDb()
    .prepare(
      `INSERT INTO email_watch_rules (user_id, match_type, pattern, description, pattern2)
       VALUES (?, ?, ?, ?, ?)`,
    )
    .run(userId, matchType, pattern, description, pattern2 ?? null);
  return Number(result.lastInsertRowid);
}

export function getActiveEmailWatchRules(
  userId: string,
): Array<{ id: number; matchType: string; pattern: string; pattern2: string | null; description: string; createdAt: string }> {
  return getDb()
    .prepare(
      `SELECT id, match_type AS matchType, pattern, pattern2, description, created_at AS createdAt
       FROM email_watch_rules WHERE user_id = ? AND active = 1 ORDER BY created_at DESC`,
    )
    .all(userId) as Array<{ id: number; matchType: string; pattern: string; pattern2: string | null; description: string; createdAt: string }>;
}

export function getAllActiveEmailWatchRules(): Array<{
  id: number; userId: string; matchType: string; pattern: string; pattern2: string | null; description: string;
}> {
  return getDb()
    .prepare(
      `SELECT id, user_id AS userId, match_type AS matchType, pattern, pattern2, description
       FROM email_watch_rules WHERE active = 1`,
    )
    .all() as Array<{ id: number; userId: string; matchType: string; pattern: string; pattern2: string | null; description: string }>;
}

export function deleteEmailWatchRule(userId: string, ruleId: number): boolean {
  const result = getDb()
    .prepare("UPDATE email_watch_rules SET active = 0 WHERE id = ? AND user_id = ?")
    .run(ruleId, userId);
  return result.changes > 0;
}

export function isEmailWatchNotified(ruleId: number, messageId: string): boolean {
  return getDb()
    .prepare("SELECT 1 FROM email_watch_notified WHERE rule_id = ? AND message_id = ?")
    .get(ruleId, messageId) !== undefined;
}

export function markEmailWatchNotified(ruleId: number, messageId: string): void {
  getDb()
    .prepare("INSERT OR IGNORE INTO email_watch_notified (rule_id, message_id) VALUES (?, ?)")
    .run(ruleId, messageId);
}

// ── 直接実行でDB初期化 ──

if (process.argv[1] && resolve(process.argv[1]) === resolve(__dirname, "queries.ts")) {
  const { mkdirSync } = await import("node:fs");
  const dbPath = process.env["DB_PATH"] || "./data/secretary.db";
  mkdirSync(dirname(dbPath), { recursive: true });
  initDb();
  console.log(`DB initialized at ${dbPath}`);
}
