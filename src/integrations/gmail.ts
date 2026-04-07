import { google } from "googleapis";
import nodemailer from "nodemailer";
import { getAuthedClient, ReauthRequiredError } from "./auth.js";
import { GoogleApiError } from "./errors.js";
import { getGoogleAccountsByUserId } from "../db/queries.js";
import type { Email } from "../types.js";
import type { GoogleAccount } from "../types.js";

function wrapGoogleError(err: unknown, userId: string): never {
  if (err instanceof ReauthRequiredError) throw err;
  if (err instanceof GoogleApiError) throw err;
  const msg = err instanceof Error ? err.message : String(err);
  const status = (err as any)?.code ?? (err as any)?.status ?? 0;
  throw new GoogleApiError(userId, msg, Number(status));
}

async function getGmailClient(userId: string, account?: GoogleAccount) {
  const auth = await getAuthedClient(userId, "gmailToken", account);
  return google.gmail({ version: "v1", auth });
}

function decodeBase64Url(data: string): string {
  return Buffer.from(data, "base64url").toString("utf-8");
}

function extractHeader(
  headers: { name?: string | null; value?: string | null }[],
  name: string,
): string {
  return headers.find((h) => h.name?.toLowerCase() === name.toLowerCase())?.value ?? "";
}

function extractBody(payload: any): string {
  // 単純なbodyがある場合
  if (payload.body?.data) {
    return decodeBase64Url(payload.body.data);
  }
  // multipartの場合、text/plainを探す
  if (payload.parts) {
    for (const part of payload.parts) {
      if (part.mimeType === "text/plain" && part.body?.data) {
        return decodeBase64Url(part.body.data);
      }
    }
    // text/plainがなければtext/htmlを試す
    for (const part of payload.parts) {
      if (part.mimeType === "text/html" && part.body?.data) {
        return decodeBase64Url(part.body.data).replace(/<[^>]+>/g, "");
      }
    }
    // ネストしたmultipart
    for (const part of payload.parts) {
      if (part.parts) {
        const nested = extractBody(part);
        if (nested) return nested;
      }
    }
  }
  return "";
}

async function getUnreadEmailsForAccount(
  userId: string,
  account?: GoogleAccount,
): Promise<Email[]> {
  const gmail = await getGmailClient(userId, account);

  const list = await gmail.users.messages.list({
    userId: "me",
    q: "is:unread",
    maxResults: 20,
  });

  const messageIds = list.data.messages ?? [];
  if (messageIds.length === 0) return [];

  const emails: Email[] = [];

  for (const { id, threadId } of messageIds) {
    if (!id) continue;
    const msg = await gmail.users.messages.get({
      userId: "me",
      id,
      format: "full",
    });

    const headers = msg.data.payload?.headers ?? [];
    const body = extractBody(msg.data.payload);

    emails.push({
      id: msg.data.id ?? "",
      threadId: threadId ?? "",
      from: extractHeader(headers, "From"),
      to: extractHeader(headers, "To"),
      cc: extractHeader(headers, "Cc"),
      subject: extractHeader(headers, "Subject"),
      body: body.slice(0, 500),
      date: extractHeader(headers, "Date"),
      isUnread: true,
      listUnsubscribe: extractHeader(headers, "List-Unsubscribe"),
      listId: extractHeader(headers, "List-Id"),
      precedence: extractHeader(headers, "Precedence"),
    });
  }

  return emails;
}

export async function getUnreadEmails(userId: string): Promise<Email[]> {
  try {
    const accounts = getGoogleAccountsByUserId(userId);

    if (accounts.length === 0) {
      return await getUnreadEmailsForAccount(userId);
    }

    const results = await Promise.allSettled(
      accounts.map((acc) => getUnreadEmailsForAccount(userId, acc)),
    );

    const emails: Email[] = [];
    const seenIds = new Set<string>();
    let lastError: unknown = null;
    for (const result of results) {
      if (result.status === "fulfilled") {
        for (const email of result.value) {
          if (!seenIds.has(email.id)) {
            seenIds.add(email.id);
            emails.push(email);
          }
        }
      } else {
        lastError = result.reason;
        console.error("[gmail] アカウント取得エラー:", result.reason);
      }
    }

    // 全アカウント失敗の場合はエラーを伝播
    if (emails.length === 0 && lastError) {
      wrapGoogleError(lastError, userId);
    }

    return emails;
  } catch (err) {
    wrapGoogleError(err, userId);
  }
}

async function getAllEmailsForAccount(
  userId: string,
  maxResults: number,
  account?: GoogleAccount,
): Promise<Email[]> {
  const gmail = await getGmailClient(userId, account);

  const list = await gmail.users.messages.list({
    userId: "me",
    labelIds: ["INBOX"],
    maxResults,
  });

  const messageIds = list.data.messages ?? [];
  if (messageIds.length === 0) return [];

  const emails: Email[] = [];

  for (const { id, threadId } of messageIds) {
    if (!id) continue;
    const msg = await gmail.users.messages.get({
      userId: "me",
      id,
      format: "full",
    });

    const headers = msg.data.payload?.headers ?? [];
    const body = extractBody(msg.data.payload);
    const labelIds = msg.data.labelIds ?? [];

    emails.push({
      id: msg.data.id ?? "",
      threadId: threadId ?? "",
      from: extractHeader(headers, "From"),
      to: extractHeader(headers, "To"),
      cc: extractHeader(headers, "Cc"),
      subject: extractHeader(headers, "Subject"),
      body: body.slice(0, 500),
      date: extractHeader(headers, "Date"),
      isUnread: labelIds.includes("UNREAD"),
      listUnsubscribe: extractHeader(headers, "List-Unsubscribe"),
      listId: extractHeader(headers, "List-Id"),
      precedence: extractHeader(headers, "Precedence"),
    });
  }

  return emails;
}

export async function getAllEmails(userId: string, maxResults = 50): Promise<Email[]> {
  try {
    const accounts = getGoogleAccountsByUserId(userId);

    if (accounts.length === 0) {
      return await getAllEmailsForAccount(userId, maxResults);
    }

    const results = await Promise.allSettled(
      accounts.map((acc) => getAllEmailsForAccount(userId, maxResults, acc)),
    );

    const emails: Email[] = [];
    const seenIds = new Set<string>();
    let lastError: unknown = null;
    for (const result of results) {
      if (result.status === "fulfilled") {
        for (const email of result.value) {
          if (!seenIds.has(email.id)) {
            seenIds.add(email.id);
            emails.push(email);
          }
        }
      } else {
        lastError = result.reason;
        console.error("[gmail] getAllEmails アカウント取得エラー:", result.reason);
      }
    }

    if (emails.length === 0 && lastError) {
      wrapGoogleError(lastError, userId);
    }

    return emails;
  } catch (err) {
    wrapGoogleError(err, userId);
  }
}

async function getRecentEmailsForAccount(
  userId: string,
  daysBack: number,
  account?: GoogleAccount,
): Promise<Email[]> {
  const gmail = await getGmailClient(userId, account);
  const list = await gmail.users.messages.list({
    userId: "me",
    q: `in:inbox newer_than:${daysBack}d`,
    maxResults: 30,
  });
  const messageIds = list.data.messages ?? [];
  if (messageIds.length === 0) return [];
  const emails: Email[] = [];
  for (const { id, threadId } of messageIds) {
    if (!id) continue;
    const msg = await gmail.users.messages.get({ userId: "me", id, format: "full" });
    const headers = msg.data.payload?.headers ?? [];
    const body = extractBody(msg.data.payload);
    const labelIds = msg.data.labelIds ?? [];
    emails.push({
      id: msg.data.id ?? "",
      threadId: threadId ?? "",
      from: extractHeader(headers, "From"),
      to: extractHeader(headers, "To"),
      cc: extractHeader(headers, "Cc"),
      subject: extractHeader(headers, "Subject"),
      body: body.slice(0, 500),
      date: extractHeader(headers, "Date"),
      isUnread: labelIds.includes("UNREAD"),
      listUnsubscribe: extractHeader(headers, "List-Unsubscribe"),
      listId: extractHeader(headers, "List-Id"),
      precedence: extractHeader(headers, "Precedence"),
    });
  }
  return emails;
}

export async function getRecentEmails(userId: string, daysBack = 14): Promise<Email[]> {
  try {
    const accounts = getGoogleAccountsByUserId(userId);
    if (accounts.length === 0) {
      return await getRecentEmailsForAccount(userId, daysBack);
    }
    const results = await Promise.allSettled(
      accounts.map((acc) => getRecentEmailsForAccount(userId, daysBack, acc)),
    );
    const emails: Email[] = [];
    const seenIds = new Set<string>();
    let lastError: unknown = null;
    for (const result of results) {
      if (result.status === "fulfilled") {
        for (const email of result.value) {
          if (!seenIds.has(email.id)) { seenIds.add(email.id); emails.push(email); }
        }
      } else { lastError = result.reason; }
    }
    if (emails.length === 0 && lastError) wrapGoogleError(lastError, userId);
    return emails;
  } catch (err) {
    wrapGoogleError(err, userId);
  }
}

async function getSentEmailsForAccount(
  userId: string,
  maxResults: number,
  account?: GoogleAccount,
): Promise<Email[]> {
  const gmail = await getGmailClient(userId, account);

  const list = await gmail.users.messages.list({
    userId: "me",
    q: "in:sent",
    maxResults,
  });

  const messageIds = list.data.messages ?? [];
  if (messageIds.length === 0) return [];

  const emails: Email[] = [];

  for (const { id, threadId } of messageIds) {
    if (!id) continue;
    const msg = await gmail.users.messages.get({
      userId: "me",
      id,
      format: "full",
    });

    const headers = msg.data.payload?.headers ?? [];
    const body = extractBody(msg.data.payload);

    emails.push({
      id: msg.data.id ?? "",
      threadId: threadId ?? "",
      from: extractHeader(headers, "From"),
      to: extractHeader(headers, "To"),
      cc: extractHeader(headers, "Cc"),
      subject: extractHeader(headers, "Subject"),
      body: body.slice(0, 500),
      date: extractHeader(headers, "Date"),
      isUnread: false,
      listUnsubscribe: extractHeader(headers, "List-Unsubscribe"),
      listId: extractHeader(headers, "List-Id"),
      precedence: extractHeader(headers, "Precedence"),
    });
  }

  return emails;
}

export async function getSentEmails(
  userId: string,
  maxResults = 10,
): Promise<Email[]> {
  try {
    const accounts = getGoogleAccountsByUserId(userId);

    if (accounts.length === 0) {
      return await getSentEmailsForAccount(userId, maxResults);
    }

    const results = await Promise.allSettled(
      accounts.map((acc) => getSentEmailsForAccount(userId, maxResults, acc)),
    );

    const emails: Email[] = [];
    const seenIds = new Set<string>();
    for (const result of results) {
      if (result.status === "fulfilled") {
        for (const email of result.value) {
          if (!seenIds.has(email.id)) {
            seenIds.add(email.id);
            emails.push(email);
          }
        }
      }
    }

    return emails;
  } catch (err) {
    wrapGoogleError(err, userId);
  }
}

export async function getThread(
  threadId: string,
  userId: string,
): Promise<Email[]> {
  try {
    const accounts = getGoogleAccountsByUserId(userId);

    for (const account of accounts) {
      try {
        return await getThreadForAccount(threadId, userId, account);
      } catch {
        // このアカウントにはスレッドがない、次へ
      }
    }

    return await getThreadForAccount(threadId, userId);
  } catch (err) {
    wrapGoogleError(err, userId);
  }
}

async function getThreadForAccount(
  threadId: string,
  userId: string,
  account?: GoogleAccount,
): Promise<Email[]> {
  const gmail = await getGmailClient(userId, account);

  const thread = await gmail.users.threads.get({
    userId: "me",
    id: threadId,
    format: "full",
  });

  const messages = thread.data.messages ?? [];

  return messages.map((msg) => {
    const headers = msg.payload?.headers ?? [];
    const body = extractBody(msg.payload);
    const labelIds = msg.labelIds ?? [];

    return {
      id: msg.id ?? "",
      threadId: thread.data.id ?? "",
      from: extractHeader(headers, "From"),
      to: extractHeader(headers, "To"),
      cc: extractHeader(headers, "Cc"),
      subject: extractHeader(headers, "Subject"),
      body,
      date: extractHeader(headers, "Date"),
      isUnread: labelIds.includes("UNREAD"),
      listUnsubscribe: extractHeader(headers, "List-Unsubscribe"),
      listId: extractHeader(headers, "List-Id"),
      precedence: extractHeader(headers, "Precedence"),
    };
  });
}

export async function sendReply(
  userId: string,
  threadId: string,
  to: string,
  subject: string,
  body: string,
): Promise<string> {
  try {
    const accounts = getGoogleAccountsByUserId(userId);

    for (const account of accounts) {
      try {
        const gmail = await getGmailClient(userId, account);
        await gmail.users.threads.get({ userId: "me", id: threadId, format: "minimal" });
        return await sendReplyWithClient(gmail, threadId, to, subject, body);
      } catch {
        // このアカウントにはスレッドがない、次へ
      }
    }

    const gmail = await getGmailClient(userId);
    return await sendReplyWithClient(gmail, threadId, to, subject, body);
  } catch (err) {
    wrapGoogleError(err, userId);
  }
}

async function sendReplyWithClient(
  gmail: ReturnType<typeof google.gmail>,
  threadId: string,
  to: string,
  subject: string,
  body: string,
): Promise<string> {
  const subjectLine = subject.startsWith("Re:") ? subject : `Re: ${subject}`;
  const raw = [
    `To: ${to}`,
    `Subject: =?UTF-8?B?${Buffer.from(subjectLine).toString("base64")}?=`,
    `In-Reply-To: ${threadId}`,
    `References: ${threadId}`,
    "Content-Type: text/plain; charset=UTF-8",
    "",
    body,
  ].join("\r\n");

  const encoded = Buffer.from(raw).toString("base64url");

  const res = await gmail.users.messages.send({
    userId: "me",
    requestBody: { raw: encoded, threadId },
  });

  return res.data.id ?? "";
}

export async function checkThreadReplied(
  threadId: string,
  userId: string,
  myEmails: string[],
): Promise<boolean> {
  try {
    const thread = await getThread(threadId, userId);
    // 自分以外からの返信があるか
    const myAddrs = myEmails.map((e) => e.toLowerCase());
    return thread.some((msg) => {
      const from = msg.from.toLowerCase();
      return !myAddrs.some((a) => from.includes(a));
    });
  } catch {
    return true; // エラー時はreplied扱い（通知しない）
  }
}

// 要返信メール用：スレッドに自分の返信があるかチェック
// true = 自分が返信済み → ダッシュボードに表示しない
// false = 未返信 → ダッシュボードに表示する
export async function checkMyReplyExists(
  threadId: string,
  userId: string,
  myEmails: string[],
): Promise<boolean> {
  try {
    const thread = await getThread(threadId, userId);
    const myAddrs = myEmails.map((e) => e.toLowerCase());
    return thread.some((msg) => {
      const from = msg.from.toLowerCase();
      return myAddrs.some((a) => from.includes(a));
    });
  } catch {
    return false; // エラー時は未返信扱い（表示する）
  }
}

export async function sendAdminNotificationEmail(
  adminEmail: string,
  applicantName: string,
  applicantEmail: string,
): Promise<void> {
  const gmailUser = process.env["GMAIL_SMTP_USER"];
  const gmailPass = process.env["GMAIL_SMTP_PASS"];

  if (!gmailUser || !gmailPass) {
    console.error("[apply] GMAIL_SMTP_USER or GMAIL_SMTP_PASS not set");
    return;
  }

  const transporter = nodemailer.createTransport({
    service: "gmail",
    auth: { user: gmailUser, pass: gmailPass },
  });

  await transporter.sendMail({
    from: `"AI\u79D8\u66F8" <${gmailUser}>`,
    to: adminEmail,
    subject: "\u3010AI\u79D8\u66F8\u3011\u65B0\u898F\u7533\u8FBC\u304C\u3042\u308A\u307E\u3057\u305F",
    text: [
      "\u65B0\u898F\u7533\u8FBC\u304C\u3042\u308A\u307E\u3057\u305F\u3002",
      "",
      `\u540D\u524D: ${applicantName}`,
      `Email: ${applicantEmail}`,
      "",
      "\u2501\u2501 \u5BFE\u5FDC\u624B\u9806 \u2501\u2501",
      "1. Google Console\u306B\u30C6\u30B9\u30C8\u30E6\u30FC\u30B6\u30FC\u3068\u3057\u3066\u8FFD\u52A0",
      "   https://console.cloud.google.com/",
      "",
      `2. AI\u79D8\u66F8LINE\u306B\u300C\u627F\u8A8D ${applicantEmail}\u300D\u3068\u9001\u4FE1`,
      "   \u2192 \u62DB\u5F85\u30E1\u30FC\u30EB\u304C\u81EA\u52D5\u9001\u4FE1\u3055\u308C\u307E\u3059",
    ].join("\n"),
  });

  console.log(`[apply] admin notification sent to ${adminEmail}`);
}

export async function sendInviteEmail(
  applicantName: string,
  applicantEmail: string,
  lineAddUrl: string,
): Promise<void> {
  const adminUserId = process.env["ADMIN_LINE_USER_ID"] ?? "";
  if (!adminUserId) throw new Error("ADMIN_LINE_USER_ID not set");

  const subject = "\u3010AI\u79D8\u66F8\u3011\u62DB\u5F85\u306E\u3054\u6848\u5185";
  const body = [
    `${applicantName}\u69D8`,
    "",
    "AI\u79D8\u66F8\u3078\u306E\u304A\u7533\u3057\u8FBC\u307F\u3042\u308A\u304C\u3068\u3046\u3054\u3056\u3044\u307E\u3059\u3002",
    "\u3054\u5229\u7528\u306E\u6E96\u5099\u304C\u6574\u3044\u307E\u3057\u305F\u306E\u3067\u3001\u3054\u6848\u5185\u3044\u305F\u3057\u307E\u3059\u3002",
    "",
    "\u2501\u2501 \u306F\u3058\u3081\u65B9\uFF083\u5206\u3067\u3067\u304D\u307E\u3059\uFF09\u2501\u2501",
    "",
    "STEP 1: \u4EE5\u4E0B\u306E\u30EA\u30F3\u30AF\u304B\u3089LINE\u3067\u53CB\u9054\u8FFD\u52A0",
    lineAddUrl,
    "",
    "STEP 2: LINE\u306B\u5C4A\u304F\u30EA\u30F3\u30AF\u304B\u3089Google\u30A2\u30AB\u30A6\u30F3\u30C8\u3092\u9023\u643A",
    "\uFF08\u30D1\u30B9\u30EF\u30FC\u30C9\u306F\u53D6\u5F97\u3057\u307E\u305B\u3093\u3002OAuth\u8A8D\u8A3C\u306E\u307F\u3067\u3059\uFF09",
    "",
    "STEP 3: \u300C\u4ECA\u65E5\u306E\u4E88\u5B9A\u306F\uFF1F\u300D\u306A\u3069\u3068\u8A71\u3057\u304B\u3051\u3066\u958B\u59CB\uFF01",
    "\u7FCC\u671D8\u6642\u304B\u3089\u6BCE\u65E5\u30D6\u30EA\u30FC\u30D5\u30A3\u30F3\u30B0\u304C\u5C4A\u304D\u307E\u3059\u3002",
    "",
    "\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501",
    "\u3054\u4E0D\u660E\u306A\u70B9\u306F\u3053\u306E\u30E1\u30FC\u30EB\u3078\u306E\u8FD4\u4FE1\u304B\u3001",
    "LINE\u306EAI\u79D8\u66F8\u306B\u76F4\u63A5\u30E1\u30C3\u30BB\u30FC\u30B8\u3092\u304A\u9001\u308A\u304F\u3060\u3055\u3044\u3002",
    "",
    "7\u65E5\u9593\u306E\u7121\u6599\u4F53\u9A13\u3092\u304A\u697D\u3057\u307F\u304F\u3060\u3055\u3044\uFF01",
    "",
    "AI\u79D8\u66F8 \u904B\u55B6\u30C1\u30FC\u30E0",
  ].join("\n");

  const message = [
    `To: ${applicantEmail}`,
    `Subject: =?UTF-8?B?${Buffer.from(subject).toString("base64")}?=`,
    "Content-Type: text/plain; charset=UTF-8",
    "Content-Transfer-Encoding: base64",
    "",
    Buffer.from(body).toString("base64"),
  ].join("\r\n");

  const encoded = Buffer.from(message)
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");

  const accounts = getGoogleAccountsByUserId(adminUserId);
  if (accounts.length === 0) throw new Error("Admin Google account not found");

  const auth = await getAuthedClient(adminUserId, "gmailToken", accounts[0]);
  const gmail = google.gmail({ version: "v1", auth });

  const res = await gmail.users.messages.send({
    userId: "me",
    requestBody: { raw: encoded },
  });

  if (!res.data.id) throw new Error("Gmail send returned no id");
}

// ── 直接実行で動作確認 ──
if (process.argv[1]?.endsWith("gmail.ts")) {
  const { initDb } = await import("../db/queries.js");
  await import("dotenv/config");
  initDb();

  const userId = process.env["LINE_USER_ID"] || "default";
  console.log("=== 未読メール取得中... ===");
  const emails = await getUnreadEmails(userId);
  console.log(`${emails.length}件の未読メール:`);
  for (const e of emails) {
    console.log(`  [${e.date}] ${e.from} - ${e.subject}`);
  }

  const first = emails[0];
  if (first) {
    console.log(`\n=== スレッド取得: ${first.threadId} ===`);
    const thread = await getThread(first.threadId, userId);
    console.log(`${thread.length}件のメッセージ:`);
    for (const m of thread) {
      console.log(`  [${m.date}] ${m.from}: ${m.body.slice(0, 100)}...`);
    }
  }
}
