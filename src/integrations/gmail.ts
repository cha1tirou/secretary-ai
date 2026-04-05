import { google } from "googleapis";
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
