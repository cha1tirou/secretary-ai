import { google } from "googleapis";
import { getAuthedClient } from "./auth.js";
import type { Email } from "../types.js";

async function getGmailClient(userId: string) {
  const auth = await getAuthedClient(userId, "gmailToken");
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

export async function getUnreadEmails(userId: string): Promise<Email[]> {
  const gmail = await getGmailClient(userId);

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
      subject: extractHeader(headers, "Subject"),
      body: body.slice(0, 500),
      date: extractHeader(headers, "Date"),
      isUnread: true,
    });
  }

  return emails;
}

export async function getSentEmails(
  userId: string,
  maxResults = 10,
): Promise<Email[]> {
  const gmail = await getGmailClient(userId);

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
      subject: extractHeader(headers, "Subject"),
      body: body.slice(0, 500),
      date: extractHeader(headers, "Date"),
      isUnread: false,
    });
  }

  return emails;
}

export async function getThread(
  threadId: string,
  userId: string,
): Promise<Email[]> {
  const gmail = await getGmailClient(userId);

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
      subject: extractHeader(headers, "Subject"),
      body,
      date: extractHeader(headers, "Date"),
      isUnread: labelIds.includes("UNREAD"),
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
  const gmail = await getGmailClient(userId);

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
