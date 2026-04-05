import { Hono } from "hono";
import { getUnreadEmails, getSentEmails, checkThreadReplied, getThread, sendReply } from "../integrations/gmail.js";
import { getWeekEvents } from "../integrations/gcal.js";
import {
  getDb,
  getGoogleAccountsByUserId,
  getUser,
  getPendingReply,
  createPendingReply,
  updatePendingReplyStatus,
} from "../db/queries.js";
import { buildAuthUrl } from "../integrations/auth.js";
import type { Email, PendingReply, CalendarEvent } from "../types.js";

const dashboard = new Hono();

function getToken(c: any): string | null {
  return c.req.query("token") ?? null;
}

function esc(str: string): string {
  return (str ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function fmtFrom(from: string): string {
  return (from.split("<")[0] ?? "").trim() || from;
}

function calcFreeSlotsForReply(events: CalendarEvent[]): string {
  const days = ["\u65E5", "\u6708", "\u706B", "\u6C34", "\u6728", "\u91D1", "\u571F"];
  const now = new Date();
  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  let text = "";
  for (let d = 0; d < 7; d++) {
    const date = new Date(startOfToday.getTime() + d * 86400000);
    const dow = date.getDay();
    if (dow === 0 || dow === 6) continue;
    const dayLabel = `${date.getMonth() + 1}/${date.getDate()}(${days[dow]})`;
    const dayEvents = events
      .filter((e) => {
        const s = new Date(e.start);
        return s.getFullYear() === date.getFullYear() && s.getMonth() === date.getMonth() && s.getDate() === date.getDate();
      })
      .sort((a, b) => new Date(a.start).getTime() - new Date(b.start).getTime());
    if (dayEvents.length === 0) {
      text += `${dayLabel}: \u7D42\u65E5\u7A7A\u304D\n`;
      continue;
    }
    const slots: string[] = [];
    let cursor = 9;
    for (const ev of dayEvents) {
      const s = new Date(ev.start).getHours();
      const e = new Date(ev.end).getHours() || s + 1;
      if (s > cursor && s - cursor >= 1) slots.push(`${cursor}:00\u301C${s}:00`);
      cursor = Math.max(cursor, e);
    }
    if (cursor < 19) slots.push(`${cursor}:00\u301C19:00`);
    if (slots.length > 0) text += `${dayLabel}: ${slots.join(", ")}\n`;
  }
  return text.trim() || "\u4ECA\u9031\u306E\u7A7A\u304D\u306F\u3042\u308A\u307E\u305B\u3093";
}

type AwaitingEmail = Email & { daysAgo: number; recipientName: string; recipientAddress: string };

// ── GET /dashboard ──
dashboard.get("/dashboard", async (c) => {
  const userId = getToken(c);
  if (!userId) return c.text("token required", 401);

  try {
    const user = getUser(userId);
    if (!user) return c.text("user not found", 404);

    const accounts = getGoogleAccountsByUserId(userId);
    if (accounts.length === 0 && !user.gmailToken) {
      const authUrl = buildAuthUrl(userId);
      return c.html(`<!DOCTYPE html><html><body style="font-family:sans-serif;text-align:center;padding:40px">
        <p style="font-size:48px">\uD83D\uDD17</p>
        <p style="font-size:18px;margin-bottom:16px">Google\u30A2\u30AB\u30A6\u30F3\u30C8\u304C\u672A\u9023\u643A\u3067\u3059</p>
        <a href="${authUrl}" style="background:#06C755;color:white;padding:12px 24px;border-radius:8px;text-decoration:none;font-weight:bold">\u9023\u643A\u3059\u308B</a>
      </body></html>`);
    }

    // \u8981\u8FD4\u4FE1\u30E1\u30FC\u30EB
    const db = getDb();
    const unrepliedRows = db.prepare(`
      SELECT pe.message_id FROM processed_emails pe
      WHERE pe.user_id = ?
        AND pe.category IN ('urgent_reply', 'reply_later')
        AND NOT EXISTS (
          SELECT 1 FROM pending_replies pr
          WHERE pr.user_id = pe.user_id AND pr.status = 'sent'
            AND pr.subject LIKE '%' || pe.message_id || '%'
        )
      ORDER BY pe.processed_at DESC
      LIMIT 10
    `).all(userId) as { message_id: string }[];

    const unread = await getUnreadEmails(userId).catch(() => [] as Email[]);
    const unrepliedEmails = unrepliedRows
      .map((row) => unread.find((e) => e.id === row.message_id))
      .filter((e): e is Email => e !== undefined);

    // \u8FD4\u4FE1\u5F85\u3061\u30E1\u30FC\u30EB
    const myEmails = accounts.map((a) => a.email).filter((e): e is string => e !== null);
    const sent = await getSentEmails(userId, 30).catch(() => [] as Email[]);
    const awaitingReply: AwaitingEmail[] = [];

    if (myEmails.length > 0) {
      for (const email of sent) {
        const sentDate = new Date(email.date).getTime();
        if (isNaN(sentDate)) continue;
        const daysAgo = Math.floor((Date.now() - sentDate) / 86400000);
        if (daysAgo < 3) continue;
        if (awaitingReply.length >= 5) break;

        const toAddresses = email.to.split(/[,;]/).map((a) => a.trim()).filter(Boolean);
        const recipientAddress = toAddresses.find((a) =>
          !myEmails.some((me) => a.toLowerCase().includes(me.toLowerCase()))
        ) ?? email.to;
        const recipientName = fmtFrom(recipientAddress);

        const replied = await checkThreadReplied(email.threadId, userId, myEmails).catch(() => true);
        if (!replied) {
          awaitingReply.push({ ...email, daysAgo, recipientName, recipientAddress });
        }
      }
    }

    return c.html(buildDashboardHtml(userId, unrepliedEmails, awaitingReply));
  } catch (err) {
    console.error("[dashboard] GET /dashboard error:", err);
    return c.html(`<!DOCTYPE html><html><body style="font-family:sans-serif;text-align:center;padding:40px">
      <p style="font-size:48px">\u26A0\uFE0F</p>
      <p style="font-size:18px;margin-bottom:8px">\u30C0\u30C3\u30B7\u30E5\u30DC\u30FC\u30C9\u306E\u8AAD\u307F\u8FBC\u307F\u306B\u5931\u6557\u3057\u307E\u3057\u305F</p>
      <p style="font-size:14px;color:#888">\u3057\u3070\u3089\u304F\u3057\u3066\u304B\u3089\u518D\u5EA6\u304A\u8A66\u3057\u304F\u3060\u3055\u3044</p>
    </body></html>`, 500);
  }
});

// ── POST /dashboard/generate-reply (Sonnet + \u30AB\u30EC\u30F3\u30C0\u30FC\u7D71\u5408) ──
dashboard.post("/dashboard/generate-reply", async (c) => {
  const userId = getToken(c);
  if (!userId) return c.text("token required", 401);

  try {
    const body = await c.req.parseBody();
    const from = (body["from"] as string) ?? "";
    const subject = (body["subject"] as string) ?? "";
    const threadId = (body["threadId"] as string) ?? "";

    const thread = await getThread(threadId, userId);
    const threadText = thread.map((e) => e.subject + " " + e.body).join(" ");
    const isScheduling = /\u65E5\u7A0B|\u30B9\u30B1\u30B8\u30E5\u30FC\u30EB|MTG|\u6253\u3061\u5408\u308F\u305B|\u30DF\u30FC\u30C6\u30A3\u30F3\u30B0|\u90FD\u5408|\u3044\u3064\u304C\u3088\u3044|\u5019\u88DC\u65E5|\u7A7A\u304D/.test(threadText);

    let calendarContext = "";
    if (isScheduling) {
      const events = await getWeekEvents(userId).catch(() => [] as CalendarEvent[]);
      if (events.length > 0) {
        calendarContext = `\n\n## \u9001\u4FE1\u8005\u306E\u4ECA\u9031\u306E\u7A7A\u304D\u6642\u9593\n${calcFreeSlotsForReply(events)}`;
      }
    }

    const latestEmail = thread[thread.length - 1];
    const senderName = latestEmail ? fmtFrom(latestEmail.from) : fmtFrom(from);

    const Anthropic = (await import("@anthropic-ai/sdk")).default;
    const client = new Anthropic();
    const msg = await client.messages.create({
      model: "claude-sonnet-4-6",
      max_tokens: 1024,
      messages: [{
        role: "user",
        content: `\u4EE5\u4E0B\u306E\u30E1\u30FC\u30EB\u30B9\u30EC\u30C3\u30C9\u3078\u306E\u8FD4\u4FE1\u6587\u3092\u4F5C\u6210\u3057\u3066\u304F\u3060\u3055\u3044\u3002\n\n\u9001\u4FE1\u8005: ${senderName}\n\u4EF6\u540D: ${subject}\n\n\u30E1\u30FC\u30EB\u30B9\u30EC\u30C3\u30C9:\n${thread.map((e) => `[${fmtFrom(e.from)}]\n${e.body.slice(0, 400)}`).join("\n\n")}${calendarContext}\n\n\u3010\u4F5C\u6210\u30EB\u30FC\u30EB\u3011\n- \u5192\u982D\u306F\u5FC5\u305A\u300C${senderName}\u69D8\u300D\u3067\u59CB\u3081\u308B\n- \u30D3\u30B8\u30CD\u30B9\u30E1\u30FC\u30EB\u3068\u3057\u3066\u9069\u5207\u306A\u6587\u4F53\n- \u7C21\u6F54\u3067\u8981\u70B9\u3092\u62BC\u3055\u3048\u305F\u5185\u5BB9\n- \u65E5\u7A0B\u8ABF\u6574\u306E\u5834\u5408\u306F\u5177\u4F53\u7684\u306A\u5019\u88DC\u65E5\u6642\u30923\u3064\u542B\u3081\u308B\n- \u300C\u50AC\u4FC3\u300D\u300C\u30EA\u30DE\u30A4\u30F3\u30C9\u300D\u306A\u3069\u306E\u8A00\u8449\u306F\u4F7F\u308F\u306A\u3044\n- \u7F72\u540D\u306F\u542B\u3081\u306A\u3044\n- \u30E1\u30FC\u30EB\u672C\u6587\u306E\u307F\u3092\u51FA\u529B`,
      }],
    });
    const draft = msg.content[0]?.type === "text" ? msg.content[0].text : "";

    const pendingId = createPendingReply({
      userId, threadId, toAddress: from,
      subject: subject.startsWith("Re:") ? subject : `Re: ${subject}`,
      draftContent: draft,
    });

    return c.redirect(`/reply?id=${pendingId}&token=${userId}`);
  } catch (err) {
    console.error("[dashboard] generate-reply error:", err);
    return c.text("Internal Server Error", 500);
  }
});

// ── POST /dashboard/generate-reminder (\u30D5\u30A9\u30ED\u30FC\u30A2\u30C3\u30D7) ──
dashboard.post("/dashboard/generate-reminder", async (c) => {
  const userId = getToken(c);
  if (!userId) return c.text("token required", 401);

  try {
    const body = await c.req.parseBody();
    const to = (body["to"] as string) ?? "";
    const subject = (body["subject"] as string) ?? "";
    const threadId = (body["threadId"] as string) ?? "";
    const toName = fmtFrom(to);

    const Anthropic = (await import("@anthropic-ai/sdk")).default;
    const client = new Anthropic();
    const msg = await client.messages.create({
      model: "claude-sonnet-4-6",
      max_tokens: 512,
      messages: [{
        role: "user",
        content: `\u4EE5\u4E0B\u306E\u4EF6\u306B\u3064\u3044\u3066\u30D5\u30A9\u30ED\u30FC\u30A2\u30C3\u30D7\u30E1\u30FC\u30EB\u3092\u4F5C\u6210\u3057\u3066\u304F\u3060\u3055\u3044\u3002\n\n\u9001\u4FE1\u5148: ${toName}\n\u4EF6\u540D: ${subject}\n\n\u3010\u4F5C\u6210\u30EB\u30FC\u30EB\u3011\n- \u5192\u982D\u306F\u5FC5\u305A\u300C${toName}\u69D8\u300D\u3067\u59CB\u3081\u308B\n- \u300C\u50AC\u4FC3\u300D\u300C\u30EA\u30DE\u30A4\u30F3\u30C9\u300D\u300C\u518D\u9001\u300D\u300C\u78BA\u8A8D\u306E\u3054\u9023\u7D61\u300D\u306A\u3069\u306E\u76F4\u63A5\u7684\u306A\u8A00\u8449\u306F\u7D76\u5BFE\u306B\u4F7F\u308F\u306A\u3044\n- \u300C\u304A\u5FD9\u3057\u3044\u3068\u3053\u308D\u6050\u308C\u5165\u308A\u307E\u3059\u304C\u300D\u300C\u3054\u78BA\u8A8D\u3044\u305F\u3060\u3051\u307E\u3059\u3068\u5E78\u3044\u3067\u3059\u300D\u7B49\u306E\u914D\u616E\u8868\u73FE\u3092\u4F7F\u3046\n- \u300C\u5148\u65E5\u3054\u9023\u7D61\u3057\u305F\u3007\u3007\u306E\u4EF6\u3067\u3059\u304C\u300D\u306A\u3069\u81EA\u7136\u306A\u66F8\u304D\u51FA\u3057\u306B\u3059\u308B\n- \u76F8\u624B\u3092\u8CAC\u3081\u305F\u308A\u6025\u304B\u3059\u8868\u73FE\u306F\u4E00\u5207\u4F7F\u308F\u306A\u3044\n- \u7C21\u6F54\u306B2\u301C3\u6587\u7A0B\u5EA6\n- \u7F72\u540D\u306F\u542B\u3081\u306A\u3044\n- \u30E1\u30FC\u30EB\u672C\u6587\u306E\u307F\u3092\u51FA\u529B`,
      }],
    });
    const draft = msg.content[0]?.type === "text" ? msg.content[0].text : "";

    const pendingId = createPendingReply({
      userId, threadId, toAddress: to,
      subject: subject.startsWith("Re:") ? subject : `Re: ${subject}`,
      draftContent: draft,
    });

    return c.redirect(`/reply?id=${pendingId}&token=${userId}`);
  } catch (err) {
    console.error("[dashboard] generate-reminder error:", err);
    return c.text("Internal Server Error", 500);
  }
});

// ── POST /dashboard/polish-reply (Haiku\u6E05\u66F8) ──
dashboard.post("/dashboard/polish-reply", async (c) => {
  const userId = getToken(c);
  if (!userId) return c.text("token required", 401);

  try {
    const body = await c.req.parseBody();
    const memo = (body["memo"] as string) ?? "";
    const from = (body["from"] as string) ?? "";
    const subject = (body["subject"] as string) ?? "";
    const threadId = (body["threadId"] as string) ?? "";
    const senderName = fmtFrom(from);

    const Anthropic = (await import("@anthropic-ai/sdk")).default;
    const client = new Anthropic();
    const msg = await client.messages.create({
      model: "claude-haiku-4-5-20251001",
      max_tokens: 512,
      messages: [{
        role: "user",
        content: `\u4EE5\u4E0B\u306E\u30E1\u30E2\u66F8\u304D\u3092\u3082\u3068\u306B\u3001\u4E01\u5BE7\u306A\u30D3\u30B8\u30CD\u30B9\u30E1\u30FC\u30EB\u3092\u4F5C\u6210\u3057\u3066\u304F\u3060\u3055\u3044\u3002\n\n\u9001\u4FE1\u5148: ${senderName}\n\u4EF6\u540D: ${subject}\n\n\u30E1\u30E2\uFF08\u4F1D\u3048\u305F\u3044\u3053\u3068\uFF09:\n${memo}\n\n\u3010\u4F5C\u6210\u30EB\u30FC\u30EB\u3011\n- \u5192\u982D\u306F\u5FC5\u305A\u300C${senderName}\u69D8\u300D\u3067\u59CB\u3081\u308B\n- \u30E1\u30E2\u306E\u5185\u5BB9\u3092\u4E01\u5BE7\u306A\u30D3\u30B8\u30CD\u30B9\u6587\u4F53\u306B\u5909\u63DB\u3059\u308B\n- \u30E1\u30E2\u306B\u306A\u3044\u5185\u5BB9\u3092\u52DD\u624B\u306B\u8FFD\u52A0\u3057\u306A\u3044\n- \u7C21\u6F54\u306B\n- \u7F72\u540D\u306F\u542B\u3081\u306A\u3044\n- \u30E1\u30FC\u30EB\u672C\u6587\u306E\u307F\u3092\u51FA\u529B`,
      }],
    });
    const draft = msg.content[0]?.type === "text" ? msg.content[0].text : memo;

    const pendingId = createPendingReply({
      userId, threadId, toAddress: from,
      subject: subject.startsWith("Re:") ? subject : `Re: ${subject}`,
      draftContent: draft,
    });

    return c.redirect(`/reply?id=${pendingId}&token=${userId}`);
  } catch (err) {
    console.error("[dashboard] polish-reply error:", err);
    return c.text("Internal Server Error", 500);
  }
});

// ── GET /reply ──
dashboard.get("/reply", (c) => {
  const userId = getToken(c);
  if (!userId) return c.text("token required", 401);
  try {
    const id = Number(c.req.query("id"));
    const pending = getPendingReply(id);
    if (!pending || pending.userId !== userId) return c.text("not found", 404);
    return c.html(buildReplyHtml(userId, pending));
  } catch (err) {
    console.error("[dashboard] GET /reply error:", err);
    return c.text("Internal Server Error", 500);
  }
});

// ── POST /reply/send ──
dashboard.post("/reply/send", async (c) => {
  const userId = getToken(c);
  if (!userId) return c.text("token required", 401);
  try {
    const body = await c.req.parseBody();
    const id = Number(body["id"]);
    const pending = getPendingReply(id);
    if (!pending || pending.userId !== userId) return c.text("not found", 404);

    const draftContent = (body["draft"] as string) || pending.draftContent;
    await sendReply(userId, pending.threadId, pending.toAddress, pending.subject, draftContent);
    updatePendingReplyStatus(id, "sent");

    return c.html(`<!DOCTYPE html><html><body style="font-family:sans-serif;text-align:center;padding:40px">
      <p style="font-size:48px">\u2705</p>
      <p style="font-size:20px">\u9001\u4FE1\u3057\u307E\u3057\u305F</p>
      <a href="/dashboard?token=${userId}" style="color:#06C755">\u30C0\u30C3\u30B7\u30E5\u30DC\u30FC\u30C9\u306B\u623B\u308B</a>
    </body></html>`);
  } catch (err) {
    console.error("[dashboard] reply/send error:", err);
    return c.text("Internal Server Error", 500);
  }
});

// ── POST /reply/skip ──
dashboard.post("/reply/skip", async (c) => {
  const userId = getToken(c);
  if (!userId) return c.text("token required", 401);
  try {
    const body = await c.req.parseBody();
    const id = Number(body["id"]);
    updatePendingReplyStatus(id, "cancelled");
    return c.redirect(`/dashboard?token=${userId}`);
  } catch (err) {
    console.error("[dashboard] reply/skip error:", err);
    return c.text("Internal Server Error", 500);
  }
});

// ── HTML builders ──

function buildDashboardHtml(
  userId: string,
  unrepliedEmails: Email[],
  awaitingReply: AwaitingEmail[],
): string {
  const token = userId;

  const unrepliedCards = unrepliedEmails.slice(0, 10).map((e) => `
    <div class="card">
      <div class="card-from">${esc(fmtFrom(e.from))}</div>
      <div class="card-subject">${esc(e.subject)}</div>
      <div class="card-date">${esc(e.date)}</div>
      <div class="card-actions">
        <form method="POST" action="/dashboard/generate-reply?token=${token}" style="display:inline">
          <input type="hidden" name="from" value="${esc(e.from)}">
          <input type="hidden" name="subject" value="${esc(e.subject)}">
          <input type="hidden" name="threadId" value="${esc(e.threadId)}">
          <button type="submit" class="btn-green">AI\u304C\u8FD4\u4FE1\u6848\u3092\u4F5C\u308B</button>
        </form>
        <button onclick="showMemo('${esc(e.id)}')" class="btn-gray">\u8981\u70B9\u3060\u3051\u4F1D\u3048\u3066AI\u304C\u6E05\u66F8</button>
      </div>
      <div id="memo-${esc(e.id)}" style="display:none;margin-top:12px">
        <form method="POST" action="/dashboard/polish-reply?token=${token}">
          <input type="hidden" name="from" value="${esc(e.from)}">
          <input type="hidden" name="subject" value="${esc(e.subject)}">
          <input type="hidden" name="threadId" value="${esc(e.threadId)}">
          <p class="memo-hint">\u4F1D\u3048\u305F\u3044\u3053\u3068\u3092\u7B87\u6761\u66F8\u304D\u3067\u66F8\u3044\u3066\u304F\u3060\u3055\u3044\u3002AI\u304C\u4E01\u5BE7\u306A\u30E1\u30FC\u30EB\u306B\u4ED5\u4E0A\u3052\u307E\u3059\u3002</p>
          <textarea name="memo" rows="4" class="memo-input" placeholder="\u30FB\u6765\u9031\u706B\u66DC\u3067OK&#10;\u30FB\u5834\u6240\u306F\u6E0B\u8C37\u5E0C\u671B&#10;\u30FB15\u6642\u4EE5\u964D\u306A\u3089\u7A7A\u3044\u3066\u308B"></textarea>
          <button type="submit" class="btn-green" style="margin-top:8px">AI\u304C\u6E05\u66F8</button>
        </form>
      </div>
    </div>`).join("");

  const awaitingCards = awaitingReply.slice(0, 5).map((e) => `
    <div class="card">
      <div class="card-from">${esc(e.recipientName)}\u3055\u3093\u3078</div>
      <div class="card-subject">${esc(e.subject)}</div>
      <div class="card-badge">\u2190 ${e.daysAgo}\u65E5\u7D4C\u904E\u3001\u8FD4\u4FE1\u5F85\u3061</div>
      <div class="card-actions">
        <form method="POST" action="/dashboard/generate-reminder?token=${token}" style="display:inline">
          <input type="hidden" name="threadId" value="${esc(e.threadId)}">
          <input type="hidden" name="to" value="${esc(e.recipientAddress)}">
          <input type="hidden" name="subject" value="${esc(e.subject)}">
          <button type="submit" class="btn-amber">\u30D5\u30A9\u30ED\u30FC\u30A2\u30C3\u30D7\u30E1\u30FC\u30EB\u3092\u4F5C\u308B</button>
        </form>
      </div>
    </div>`).join("");

  return `<!DOCTYPE html>
<html lang="ja">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>AI\u79D8\u66F8 \u30C0\u30C3\u30B7\u30E5\u30DC\u30FC\u30C9</title>
<style>
* { margin:0; padding:0; box-sizing:border-box; }
body { font-family:-apple-system,sans-serif; background:#f9fafb; min-height:100vh; }
.header { background:#1a1a2e; color:white; padding:16px 20px; font-size:18px; font-weight:700; }
.container { max-width:600px; margin:0 auto; padding:20px; }
.tabs { display:flex; border-bottom:2px solid #e5e7eb; margin-bottom:16px; }
.tab { flex:1; text-align:center; padding:12px; font-size:14px; font-weight:600; cursor:pointer; border-bottom:2px solid transparent; margin-bottom:-2px; color:#9ca3af; }
.tab.active { color:#06C755; border-bottom-color:#06C755; }
.tab-content { display:none; }
.tab-content.active { display:block; }
.card { border:1px solid #e5e7eb; border-radius:12px; padding:16px; margin-bottom:12px; }
.card-from { font-weight:600; margin-bottom:4px; }
.card-subject { color:#6b7280; font-size:14px; margin-bottom:4px; }
.card-date { color:#9ca3af; font-size:12px; margin-bottom:12px; }
.card-badge { color:#f59e0b; font-size:13px; margin-bottom:12px; }
.card-actions { display:flex; flex-wrap:wrap; gap:8px; }
.btn-green { background:#06C755; color:white; border:none; border-radius:8px; padding:8px 14px; font-size:13px; cursor:pointer; }
.btn-gray { background:#f3f4f6; color:#374151; border:none; border-radius:8px; padding:8px 14px; font-size:13px; cursor:pointer; }
.btn-amber { background:#f59e0b; color:white; border:none; border-radius:8px; padding:8px 14px; font-size:13px; cursor:pointer; }
.memo-hint { font-size:13px; color:#6b7280; margin-bottom:8px; }
.memo-input { width:100%; border:1px solid #e5e7eb; border-radius:8px; padding:8px; font-size:14px; box-sizing:border-box; }
.empty { color:#9ca3af; font-size:14px; padding:16px 0; }
</style>
</head>
<body>
<div class="header">\uD83E\uDD16 AI\u79D8\u66F8 \u30C0\u30C3\u30B7\u30E5\u30DC\u30FC\u30C9</div>
<div class="container">
  <div class="tabs">
    <div class="tab active" onclick="switchTab('reply')">\uD83D\uDCEC \u8981\u8FD4\u4FE1</div>
    <div class="tab" onclick="switchTab('awaiting')">\u23F3 \u8FD4\u4FE1\u5F85\u3061</div>
  </div>
  <div id="tab-reply" class="tab-content active">
    ${unrepliedCards || '<p class="empty">\u8981\u8FD4\u4FE1\u306E\u30E1\u30FC\u30EB\u306F\u3042\u308A\u307E\u305B\u3093</p>'}
  </div>
  <div id="tab-awaiting" class="tab-content">
    ${awaitingCards || '<p class="empty">\u8FD4\u4FE1\u5F85\u3061\u306E\u30E1\u30FC\u30EB\u306F\u3042\u308A\u307E\u305B\u3093</p>'}
  </div>
</div>
<script>
function switchTab(name) {
  document.querySelectorAll('.tab').forEach(function(t, i) {
    t.classList.toggle('active', (name === 'reply' && i === 0) || (name === 'awaiting' && i === 1));
  });
  document.getElementById('tab-reply').classList.toggle('active', name === 'reply');
  document.getElementById('tab-awaiting').classList.toggle('active', name === 'awaiting');
}
function showMemo(id) {
  var el = document.getElementById('memo-' + id);
  if (el) el.style.display = el.style.display === 'none' ? 'block' : 'none';
}
</script>
</body>
</html>`;
}

function buildReplyHtml(userId: string, pending: PendingReply): string {
  return `<!DOCTYPE html>
<html lang="ja">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>\u8FD4\u4FE1\u6848\u306E\u78BA\u8A8D</title>
<style>
* { margin:0; padding:0; box-sizing:border-box; }
body { font-family:-apple-system,sans-serif; background:#f9fafb; }
.header { background:#1a1a2e; color:white; padding:16px 20px; font-size:18px; font-weight:700; }
.container { max-width:600px; margin:0 auto; padding:20px; }
.card { background:white; border:1px solid #e5e7eb; border-radius:12px; padding:20px; margin-bottom:16px; }
.label { font-size:13px; color:#6b7280; margin-bottom:4px; }
.value { font-size:15px; color:#111; margin-bottom:16px; }
.body { font-size:14px; color:#374151; line-height:1.7; white-space:pre-wrap; }
.draft-edit { width:100%; border:1px solid #e5e7eb; border-radius:8px; padding:12px; font-size:14px; line-height:1.7; box-sizing:border-box; display:none; }
.btn-edit { width:100%; background:#f3f4f6; color:#374151; border:none; border-radius:12px; padding:12px; font-size:15px; cursor:pointer; margin-bottom:12px; }
.btn-send { width:100%; background:#06C755; color:white; border:none; border-radius:12px; padding:16px; font-size:16px; font-weight:700; cursor:pointer; margin-bottom:12px; }
.btn-cancel { width:100%; background:#f3f4f6; color:#374151; border:none; border-radius:12px; padding:14px; font-size:15px; cursor:pointer; }
</style>
</head>
<body>
<div class="header">\uD83E\uDD16 \u8FD4\u4FE1\u6848\u306E\u78BA\u8A8D</div>
<div class="container">
  <div class="card">
    <div class="label">\u5B9B\u5148</div>
    <div class="value">${esc(fmtFrom(pending.toAddress))}</div>
    <div class="label">\u4EF6\u540D</div>
    <div class="value">${esc(pending.subject)}</div>
    <div class="label">\u8FD4\u4FE1\u6848</div>
    <div id="draft-view" class="body">${esc(pending.draftContent)}</div>
    <textarea id="draft-edit" class="draft-edit" rows="10">${esc(pending.draftContent)}</textarea>
  </div>
  <button onclick="toggleEdit()" class="btn-edit">\u270F\uFE0F \u7DE8\u96C6\u3059\u308B</button>
  <form method="POST" action="/reply/send?token=${userId}">
    <input type="hidden" name="id" value="${pending.id}">
    <input type="hidden" id="draft-input" name="draft" value="${esc(pending.draftContent)}">
    <button type="submit" class="btn-send">\u2705 \u9001\u4FE1\u3059\u308B</button>
  </form>
  <form method="POST" action="/reply/skip?token=${userId}">
    <input type="hidden" name="id" value="${pending.id}">
    <button type="submit" class="btn-cancel">\u30AD\u30E3\u30F3\u30BB\u30EB</button>
  </form>
</div>
<script>
function toggleEdit() {
  var view = document.getElementById('draft-view');
  var edit = document.getElementById('draft-edit');
  var input = document.getElementById('draft-input');
  var btn = document.querySelector('.btn-edit');
  if (edit.style.display === 'none' || edit.style.display === '') {
    view.style.display = 'none';
    edit.style.display = 'block';
    btn.textContent = '\u270F\uFE0F \u7DE8\u96C6\u3092\u5B8C\u4E86';
  } else {
    view.textContent = edit.value;
    input.value = edit.value;
    view.style.display = 'block';
    edit.style.display = 'none';
    btn.textContent = '\u270F\uFE0F \u7DE8\u96C6\u3059\u308B';
  }
}
</script>
</body>
</html>`;
}

export { dashboard };
