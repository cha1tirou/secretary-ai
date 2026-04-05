import { Hono } from "hono";
import { getUnreadEmails, getSentEmails, checkThreadReplied, getThread, sendReply } from "../integrations/gmail.js";
import { generateReply } from "../agents/reply.js";
import { getGoogleAccountsByUserId, getPendingRepliesByStatus, createPendingReply, updatePendingReplyStatus } from "../db/queries.js";
import type { Email, PendingReply } from "../types.js";

const dashboard = new Hono();

function getToken(c: any): string | null {
  return c.req.query("token") ?? null;
}

// ── GET /dashboard ──
dashboard.get("/dashboard", async (c) => {
  const userId = getToken(c);
  if (!userId) return c.text("token required", 401);

  const unread = await getUnreadEmails(userId);

  const accounts = getGoogleAccountsByUserId(userId);
  const myEmails = accounts.map((a) => a.email).filter((e): e is string => e !== null);
  const sent = await getSentEmails(userId, 20);
  const awaitingReply: (Email & { daysAgo: number })[] = [];
  for (const email of sent.slice(0, 20)) {
    const replied = await checkThreadReplied(email.threadId, userId, myEmails).catch(() => true);
    if (!replied) {
      const sentDate = new Date(email.date).getTime();
      const daysAgo = Math.floor((Date.now() - sentDate) / 86400000);
      if (daysAgo >= 3) {
        awaitingReply.push({ ...email, daysAgo });
        if (awaitingReply.length >= 5) break;
      }
    }
  }

  const pending = getPendingRepliesByStatus(userId, "pending");
  return c.html(buildDashboardHtml(userId, unread, awaitingReply, pending));
});

// ── POST /dashboard/generate-reply ──
dashboard.post("/dashboard/generate-reply", async (c) => {
  const userId = getToken(c);
  if (!userId) return c.text("token required", 401);

  const body = await c.req.parseBody();
  const emailId = body["emailId"] as string;
  const from = body["from"] as string;
  const subject = body["subject"] as string;
  const threadId = body["threadId"] as string;

  const thread = await getThread(threadId, userId);
  const draft = await generateReply(thread, userId);

  const pendingId = createPendingReply({
    userId,
    threadId,
    toAddress: from,
    subject: subject.startsWith("Re:") ? subject : `Re: ${subject}`,
    draftContent: draft,
  });

  return c.redirect(`/reply?id=${pendingId}&token=${userId}`);
});

// ── POST /dashboard/polish-reply ──
dashboard.post("/dashboard/polish-reply", async (c) => {
  const userId = getToken(c);
  if (!userId) return c.text("token required", 401);

  const body = await c.req.parseBody();
  const memo = body["memo"] as string;
  const from = body["from"] as string;
  const subject = body["subject"] as string;
  const threadId = body["threadId"] as string;

  const Anthropic = (await import("@anthropic-ai/sdk")).default;
  const client = new Anthropic();
  const msg = await client.messages.create({
    model: "claude-haiku-4-5-20251001",
    max_tokens: 512,
    messages: [{
      role: "user",
      content: `\u4EE5\u4E0B\u306E\u30E1\u30E2\u66F8\u304D\u3092\u3082\u3068\u306B\u3001\u30D3\u30B8\u30CD\u30B9\u30E1\u30FC\u30EB\u3068\u3057\u3066\u4E01\u5BE7\u306B\u6E05\u66F8\u3057\u3066\u304F\u3060\u3055\u3044\u3002\n\u5B9B\u5148: ${from}\n\u4EF6\u540D: ${subject}\n\n\u30E1\u30E2:\n${memo}\n\n\u6E05\u66F8\u3057\u305F\u30E1\u30FC\u30EB\u672C\u6587\u306E\u307F\u3092\u51FA\u529B\u3057\u3066\u304F\u3060\u3055\u3044\u3002`,
    }],
  });
  const draft = msg.content[0]?.type === "text" ? msg.content[0].text : memo;

  const pendingId = createPendingReply({
    userId,
    threadId,
    toAddress: from,
    subject: subject.startsWith("Re:") ? subject : `Re: ${subject}`,
    draftContent: draft,
  });

  return c.redirect(`/reply?id=${pendingId}&token=${userId}`);
});

// ── GET /reply ──
dashboard.get("/reply", (c) => {
  const userId = getToken(c);
  if (!userId) return c.text("token required", 401);
  const id = Number(c.req.query("id"));
  const pending = getPendingRepliesByStatus(userId, "pending").find((p) => p.id === id);
  if (!pending) return c.text("not found", 404);
  return c.html(buildReplyHtml(userId, pending));
});

// ── POST /reply/send ──
dashboard.post("/reply/send", async (c) => {
  const userId = getToken(c);
  if (!userId) return c.text("token required", 401);
  const body = await c.req.parseBody();
  const id = Number(body["id"]);
  const pending = getPendingRepliesByStatus(userId, "pending").find((p) => p.id === id);
  if (!pending) return c.text("not found", 404);

  await sendReply(userId, pending.threadId, pending.toAddress, pending.subject, pending.draftContent);
  updatePendingReplyStatus(id, "sent");

  return c.html(`<!DOCTYPE html><html><body style="font-family:sans-serif;text-align:center;padding:40px">
    <p style="font-size:48px">\u2705</p>
    <p style="font-size:20px">\u9001\u4FE1\u3057\u307E\u3057\u305F</p>
    <a href="/dashboard?token=${userId}" style="color:#06C755">\u30C0\u30C3\u30B7\u30E5\u30DC\u30FC\u30C9\u306B\u623B\u308B</a>
  </body></html>`);
});

// ── POST /reply/skip ──
dashboard.post("/reply/skip", async (c) => {
  const userId = getToken(c);
  if (!userId) return c.text("token required", 401);
  const body = await c.req.parseBody();
  const id = Number(body["id"]);
  updatePendingReplyStatus(id, "cancelled");
  return c.redirect(`/dashboard?token=${userId}`);
});

// ── HTML builders ──

function esc(str: string): string {
  return (str ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function fmtFrom(from: string): string {
  return (from.split("<")[0] ?? "").trim() || from;
}

function buildDashboardHtml(
  userId: string,
  unread: Email[],
  awaitingReply: (Email & { daysAgo: number })[],
  pending: PendingReply[],
): string {
  const token = userId;

  const unrepliedRows = unread.slice(0, 10).map((e) => `
    <div style="border:1px solid #e5e7eb;border-radius:12px;padding:16px;margin-bottom:12px">
      <div style="font-weight:600;margin-bottom:4px">${esc(fmtFrom(e.from))}</div>
      <div style="color:#6b7280;font-size:14px;margin-bottom:12px">${esc(e.subject)}</div>
      <form method="POST" action="/dashboard/generate-reply?token=${token}" style="display:inline">
        <input type="hidden" name="emailId" value="${e.id}">
        <input type="hidden" name="from" value="${esc(e.from)}">
        <input type="hidden" name="subject" value="${esc(e.subject)}">
        <input type="hidden" name="threadId" value="${e.threadId}">
        <button type="submit" style="background:#06C755;color:white;border:none;border-radius:8px;padding:8px 14px;font-size:13px;cursor:pointer;margin-right:8px">AI\u304C\u8FD4\u4FE1\u6848\u3092\u4F5C\u308B</button>
      </form>
      <button onclick="showMemo('${e.id}')" style="background:#f3f4f6;color:#374151;border:none;border-radius:8px;padding:8px 14px;font-size:13px;cursor:pointer;margin-right:8px">\u8981\u70B9\u3060\u3051\u4F1D\u3048\u3066AI\u304C\u6E05\u66F8</button>
      <a href="/dashboard?token=${token}" style="color:#9ca3af;font-size:13px">\u5F8C\u3067</a>
      <div id="memo-${e.id}" style="display:none;margin-top:12px">
        <form method="POST" action="/dashboard/polish-reply?token=${token}">
          <input type="hidden" name="emailId" value="${e.id}">
          <input type="hidden" name="from" value="${esc(e.from)}">
          <input type="hidden" name="subject" value="${esc(e.subject)}">
          <input type="hidden" name="threadId" value="${e.threadId}">
          <p style="font-size:13px;color:#6b7280;margin-bottom:8px">\u4F1D\u3048\u305F\u3044\u3053\u3068\u3092\u7B87\u6761\u66F8\u304D\u3067\u66F8\u3044\u3066\u304F\u3060\u3055\u3044\u3002AI\u304C\u4E01\u5BE7\u306A\u30E1\u30FC\u30EB\u306B\u4ED5\u4E0A\u3052\u307E\u3059\u3002</p>
          <textarea name="memo" rows="4" style="width:100%;border:1px solid #e5e7eb;border-radius:8px;padding:8px;font-size:14px;box-sizing:border-box" placeholder="\u30FB\u6765\u9031\u706B\u66DC\u3067OK&#10;\u30FB\u5834\u6240\u306F\u6E0B\u8C37\u5E0C\u671B&#10;\u30FB15\u6642\u4EE5\u964D\u306A\u3089\u7A7A\u3044\u3066\u308B"></textarea>
          <button type="submit" style="background:#06C755;color:white;border:none;border-radius:8px;padding:8px 16px;font-size:13px;cursor:pointer;margin-top:8px">AI\u304C\u6E05\u66F8\u3057\u3066\u9001\u4FE1\u3059\u308B</button>
        </form>
      </div>
    </div>`).join("");

  const awaitingRows = awaitingReply.slice(0, 5).map((e) => {
    const to = fmtFrom(e.to);
    return `
    <div style="border:1px solid #e5e7eb;border-radius:12px;padding:16px;margin-bottom:12px">
      <div style="font-weight:600;margin-bottom:4px">${esc(to)}\u3055\u3093\u3078</div>
      <div style="color:#6b7280;font-size:14px;margin-bottom:4px">${esc(e.subject)}</div>
      <div style="color:#f59e0b;font-size:13px">\u2190 ${e.daysAgo}\u65E5\u7D4C\u904E\u3001\u8FD4\u4FE1\u5F85\u3061</div>
    </div>`;
  }).join("");

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
h2 { font-size:16px; font-weight:700; margin:24px 0 12px; color:#111; }
.empty { color:#9ca3af; font-size:14px; padding:16px 0; }
</style>
</head>
<body>
<div class="header">\uD83E\uDD16 AI\u79D8\u66F8 \u30C0\u30C3\u30B7\u30E5\u30DC\u30FC\u30C9</div>
<div class="container">
  <h2>\uD83D\uDCEC \u8981\u8FD4\u4FE1\u30E1\u30FC\u30EB</h2>
  ${unrepliedRows || '<p class="empty">\u8981\u8FD4\u4FE1\u306E\u30E1\u30FC\u30EB\u306F\u3042\u308A\u307E\u305B\u3093</p>'}
  <h2>\u23F3 \u8FD4\u4FE1\u5F85\u3061\u30E1\u30FC\u30EB</h2>
  ${awaitingRows || '<p class="empty">\u8FD4\u4FE1\u5F85\u3061\u306E\u30E1\u30FC\u30EB\u306F\u3042\u308A\u307E\u305B\u3093</p>'}
</div>
<script>
function showMemo(id) {
  var el = document.getElementById('memo-' + id);
  el.style.display = el.style.display === 'none' ? 'block' : 'none';
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
.btn-send { width:100%; background:#06C755; color:white; border:none; border-radius:12px; padding:16px; font-size:16px; font-weight:700; cursor:pointer; margin-bottom:12px; }
.btn-skip { width:100%; background:#f3f4f6; color:#374151; border:none; border-radius:12px; padding:14px; font-size:15px; cursor:pointer; }
</style>
</head>
<body>
<div class="header">\uD83E\uDD16 \u8FD4\u4FE1\u6848\u306E\u78BA\u8A8D</div>
<div class="container">
  <div class="card">
    <div class="label">\u5B9B\u5148</div>
    <div class="value">${esc(pending.toAddress)}</div>
    <div class="label">\u4EF6\u540D</div>
    <div class="value">${esc(pending.subject)}</div>
    <div class="label">\u8FD4\u4FE1\u6848</div>
    <div class="body">${esc(pending.draftContent)}</div>
  </div>
  <form method="POST" action="/reply/send?token=${userId}">
    <input type="hidden" name="id" value="${pending.id}">
    <button type="submit" class="btn-send">\u2705 \u3053\u306E\u307E\u307E\u9001\u4FE1</button>
  </form>
  <form method="POST" action="/reply/skip?token=${userId}">
    <input type="hidden" name="id" value="${pending.id}">
    <button type="submit" class="btn-skip">\u5F8C\u3067</button>
  </form>
</div>
</body>
</html>`;
}

export { dashboard };
