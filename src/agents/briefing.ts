import Anthropic from "@anthropic-ai/sdk";
import { getTodayEvents, getTomorrowEvents } from "../integrations/gcal.js";
import { getRecentEmails, getSentEmails, checkThreadReplied, checkMyReplyExists } from "../integrations/gmail.js";
import { getWeatherSummary, getTomorrowWeatherSummary } from "../integrations/weather.js";
import { classifyEmailWithCache } from "./classifier.js";
import { getGoogleAccountsByUserId, getTasks } from "../db/queries.js";
import type { CalendarEvent, Email } from "../types.js";

const isDev = process.env["NODE_ENV"] === "development";

// ── Helpers ──

function fmtTime(isoStr: string): string {
  if (!isoStr.includes("T")) return "\u7D42\u65E5";
  return new Date(isoStr).toLocaleTimeString("ja-JP", { hour: "2-digit", minute: "2-digit" });
}

function fmtFrom(from: string): string {
  return (from.split("<")[0] ?? "").trim() || from;
}

type NeedsReplyEmail = { from: string; subject: string; daysAgo: number };
type AwaitingReplyEmail = { to: string; subject: string; daysAgo: number };

// ── Types ──

type MorningContext = {
  weather: string;
  events: CalendarEvent[];
  unreadCount: number;
  needsReplyEmails: NeedsReplyEmail[];
  awaitingReplyEmails: AwaitingReplyEmail[];
  tasks: { id: number; title: string; dueDate?: string | null }[];
};

// ── Morning Briefing (8:00, Haiku) ──

async function buildMorningContext(userId: string): Promise<MorningContext> {
  const accounts = getGoogleAccountsByUserId(userId);
  const myEmails = accounts.map((a) => a.email).filter((e): e is string => e !== null);

  const [weather, events, recentEmails, sentEmails] = await Promise.all([
    getWeatherSummary().catch(() => ""),
    getTodayEvents(userId).catch(() => [] as CalendarEvent[]),
    getRecentEmails(userId, 14).catch(() => [] as Email[]),
    getSentEmails(userId, 20).catch(() => [] as Email[]),
  ]);

  const unreadCount = recentEmails.filter((e) => e.isUnread).length;

  // 要返信メール（キャッシュ付き分類）
  const needsReplyEmails: NeedsReplyEmail[] = [];
  for (const email of recentEmails) {
    if (needsReplyEmails.length >= 3) break;
    const subjectClean = (email.subject ?? "").trim();
    const isAutoSender = /no-?reply|noreply|newsletter|notifications?|donotreply|marketing|bounce/i.test(email.from);
    if (subjectClean === "" && isAutoSender) continue;
    if (subjectClean === "Re:" && isAutoSender) continue;
    const category = await classifyEmailWithCache(email, userId, myEmails[0]).catch(() => "fyi" as const);
    if (category !== "reply_later" && category !== "urgent_reply") continue;
    const myReplyExists = await checkMyReplyExists(email.threadId, userId, myEmails).catch(() => false);
    if (myReplyExists) continue;
    const daysAgo = Math.floor((Date.now() - new Date(email.date).getTime()) / 86400000);
    needsReplyEmails.push({ from: fmtFrom(email.from), subject: email.subject, daysAgo });
  }

  // 返信待ちメール（3日以上・最大2件）
  const awaitingReplyEmails: AwaitingReplyEmail[] = [];
  const SKIP_RE = /no-?reply|noreply|unsubscribe|marketing|newsletter/i;
  for (const email of sentEmails) {
    if (awaitingReplyEmails.length >= 2) break;
    const sentDate = new Date(email.date).getTime();
    if (isNaN(sentDate)) continue;
    const daysAgo = Math.floor((Date.now() - sentDate) / 86400000);
    if (daysAgo < 3 || daysAgo > 90) continue;
    if (!email.subject || email.subject.trim() === "") continue;
    const toAddr = email.to.split(/[,;]/).map((a) => a.trim()).find((a) =>
      !myEmails.some((me) => a.toLowerCase().includes(me.toLowerCase()))
    );
    if (!toAddr || SKIP_RE.test(toAddr)) continue;
    const replied = await checkThreadReplied(email.threadId, userId, myEmails).catch(() => true);
    if (replied) continue;
    awaitingReplyEmails.push({ to: fmtFrom(toAddr), subject: email.subject, daysAgo });
  }

  const tasks = getTasks(userId, "todo").slice(0, 5).map((t) => ({ id: t.id, title: t.title, dueDate: t.dueDate }));

  return { weather, events, unreadCount, needsReplyEmails, awaitingReplyEmails, tasks };
}

function buildMorningPrompt(ctx: MorningContext): string {
  const eventSection = ctx.events.length === 0
    ? "\u4ECA\u65E5\u306E\u4E88\u5B9A\u306F\u3042\u308A\u307E\u305B\u3093\u3002"
    : ctx.events.map((e) => {
        const loc = e.location ? ` (${e.location})` : "";
        return `- ${fmtTime(e.start)} ${e.summary}${loc}`;
      }).join("\n");

  const concerns: string[] = [];
  for (const e of ctx.needsReplyEmails) {
    const dayStr = e.daysAgo === 0 ? "\u4ECA\u65E5" : e.daysAgo === 1 ? "\u6628\u65E5" : `${e.daysAgo}\u65E5\u524D`;
    concerns.push(`\u26A0\uFE0F ${e.from}\u3055\u3093\u304B\u3089\u300C${e.subject}\u300D\uFF08${dayStr}\u53D7\u4FE1\uFF09\u2192 \u307E\u3060\u8FD4\u4FE1\u3067\u304D\u3066\u3044\u307E\u305B\u3093`);
  }
  for (const e of ctx.awaitingReplyEmails) {
    concerns.push(`\u26A0\uFE0F ${e.to}\u3055\u3093\u3078\u306E\u300C${e.subject}\u300D\u2192 ${e.daysAgo}\u65E5\u7D4C\u904E\u3001\u8FD4\u4FE1\u304C\u6765\u3066\u3044\u307E\u305B\u3093`);
  }

  return `\u3042\u306A\u305F\u306FLINE\u3067\u52D5\u304FAI\u79D8\u66F8\u3067\u3059\u3002\u4EE5\u4E0B\u306E\u60C5\u5831\u3092\u3082\u3068\u306B\u3001\u671D\u306E\u30D6\u30EA\u30FC\u30D5\u30A3\u30F3\u30B0\u3092\u4F5C\u6210\u3057\u3066\u304F\u3060\u3055\u3044\u3002

## \u30EB\u30FC\u30EB
- LINE\u3067\u8AAD\u307F\u3084\u3059\u3044\u7C21\u6F54\u306A\u5F62\u5F0F
- 1000\u6587\u5B57\u4EE5\u5185

## \u5929\u6C17
${ctx.weather || "\u60C5\u5831\u306A\u3057"}

## \u4ECA\u65E5\u306E\u4E88\u5B9A
${eventSection}

## \u6C17\u306B\u306A\u308B\u3053\u3068
${concerns.length === 0 ? "\u306A\u3057" : concerns.join("\n")}

## \u30BF\u30B9\u30AF\uFF08${ctx.tasks.length}\u4EF6\uFF09
${ctx.tasks.length === 0 ? "\u306A\u3057" : ctx.tasks.map((t) => `- ${t.title}${t.dueDate ? `\uFF08\u671F\u65E5: ${t.dueDate}\uFF09` : ""}`).join("\n")}

## \u672A\u8AAD\u30E1\u30FC\u30EB
${ctx.unreadCount}\u4EF6`;
}

function buildMorningMock(ctx: MorningContext): string {
  const date = new Date().toLocaleDateString("ja-JP", { month: "long", day: "numeric", weekday: "short" });
  let text = `\u304A\u306F\u3088\u3046\u3054\u3056\u3044\u307E\u3059\u3002${date}\u3067\u3059\u3002\n`;
  if (ctx.weather) text += `\n${ctx.weather}\n`;

  text += `\n\u2501\u2501 \u4ECA\u65E5\u306E\u4E88\u5B9A \u2501\u2501\n`;
  if (ctx.events.length === 0) {
    text += "\u4E88\u5B9A\u306F\u3042\u308A\u307E\u305B\u3093\u3002\n";
  } else {
    for (const e of ctx.events) {
      text += `${fmtTime(e.start)} ${e.summary}`;
      if (e.location) text += ` \u2190 ${e.location}`;
      text += "\n";
    }
  }

  const concerns: string[] = [];
  for (const e of ctx.needsReplyEmails) {
    const dayStr = e.daysAgo === 0 ? "\u4ECA\u65E5" : e.daysAgo === 1 ? "\u6628\u65E5" : `${e.daysAgo}\u65E5\u524D`;
    concerns.push(`\u26A0\uFE0F ${e.from}\u3055\u3093\u300C${e.subject}\u300D\uFF08${dayStr}\uFF09\u2192 \u672A\u8FD4\u4FE1`);
  }
  for (const e of ctx.awaitingReplyEmails) {
    concerns.push(`\u26A0\uFE0F ${e.to}\u3055\u3093\u3078\u300C${e.subject}\u300D\u2190 ${e.daysAgo}\u65E5\u7D4C\u904E`);
  }
  if (concerns.length > 0) {
    text += `\n\u2501\u2501 \u6C17\u306B\u306A\u308B\u3053\u3068 \u2501\u2501\n`;
    text += concerns.join("\n") + "\n";
  }

  if (ctx.tasks.length > 0) {
    text += `\n\u2501\u2501 \u30BF\u30B9\u30AF \u2501\u2501\n`;
    for (const t of ctx.tasks) {
      text += `\u30FB${t.title}${t.dueDate ? `\uFF08\u671F\u65E5: ${t.dueDate}\uFF09` : ""}\n`;
    }
  }

  if (ctx.unreadCount > 0) {
    text += `\n\u2501\u2501 \u672A\u8AAD\u30E1\u30FC\u30EB \u2501\u2501\n`;
    text += `${ctx.unreadCount}\u4EF6\u306E\u672A\u8AAD\u30E1\u30FC\u30EB\u304C\u3042\u308A\u307E\u3059\u3002\n`;
  }

  return text.trim();
}

export async function generateBriefing(userId: string): Promise<string> {
  const ctx = await buildMorningContext(userId);
  const dashboardLink = `\n\n\u2192 \u30E1\u30FC\u30EB\u51E6\u7406\nhttps://web-production-b2798.up.railway.app/dashboard?token=${userId}\n\n\u2192 \u30BF\u30B9\u30AF\u7BA1\u7406\nhttps://web-production-b2798.up.railway.app/dashboard/tasks?token=${userId}`;

  if (isDev) {
    return buildMorningMock(ctx) + dashboardLink;
  }

  try {
    const client = new Anthropic();
    const message = await client.messages.create({
      model: "claude-haiku-4-5-20251001",
      max_tokens: 1024,
      messages: [{ role: "user", content: buildMorningPrompt(ctx) }],
    });
    const block = message.content[0];
    if (block?.type === "text") return block.text + dashboardLink;
  } catch (err) {
    console.error("[briefing] Haiku\u30A8\u30E9\u30FC\u3001\u30E2\u30C3\u30AF\u306B\u30D5\u30A9\u30FC\u30EB\u30D0\u30C3\u30AF:", err);
  }
  return buildMorningMock(ctx) + dashboardLink;
}

// ── Noon Briefing (12:00, Rule-based) ──

export async function generateNoonBriefing(userId: string): Promise<string> {
  try {
    const accounts = getGoogleAccountsByUserId(userId);
    const myEmails = accounts.map((a) => a.email).filter((e): e is string => e !== null);

    const events = await getTodayEvents(userId).catch(() => [] as CalendarEvent[]);
    const afternoonEvents = events.filter((e) => {
      if (!e.start.includes("T")) return false;
      return new Date(e.start).getHours() >= 13;
    });

    let text = "\u5348\u5F8C\u306E\u4E88\u5B9A\u3067\u3059\u3002\n";
    text += "\n\u2501\u2501 \u5348\u5F8C\u306E\u30B9\u30B1\u30B8\u30E5\u30FC\u30EB \u2501\u2501\n";
    if (afternoonEvents.length === 0) {
      text += "\u5348\u5F8C\u306E\u4E88\u5B9A\u306F\u3042\u308A\u307E\u305B\u3093\u3002\n";
    } else {
      for (const e of afternoonEvents) {
        text += `${fmtTime(e.start)} ${e.summary}`;
        if (e.location) text += ` \u2190 ${e.location}`;
        text += "\n";
      }
    }

    // 要返信メール（キャッシュ付き分類）
    const recentEmails = await getRecentEmails(userId, 14).catch(() => [] as Email[]);
    let needsReplyCount = 0;
    for (const email of recentEmails) {
      if (needsReplyCount >= 5) break;
      const noonSubject = (email.subject ?? "").trim();
      const noonAutoSender = /no-?reply|noreply|newsletter|notifications?|donotreply|marketing|bounce/i.test(email.from);
      if (noonSubject === "" && noonAutoSender) continue;
      if (noonSubject === "Re:" && noonAutoSender) continue;
      const cat = await classifyEmailWithCache(email, userId, myEmails[0]).catch(() => "fyi" as const);
      if (cat !== "reply_later" && cat !== "urgent_reply") continue;
      const myReply = await checkMyReplyExists(email.threadId, userId, myEmails).catch(() => false);
      if (!myReply) needsReplyCount++;
    }

    if (needsReplyCount > 0) {
      text += `\n\u2501\u2501 \u6C17\u306B\u306A\u308B\u3053\u3068 \u2501\u2501\n`;
      text += `\u30FB\u672A\u8FD4\u4FE1\u30E1\u30FC\u30EB\u304C${needsReplyCount}\u4EF6\u3042\u308A\u307E\u3059\n`;
    }

    text += `\n\u2192 \u30E1\u30FC\u30EB\u51E6\u7406\nhttps://web-production-b2798.up.railway.app/dashboard?token=${userId}\n\n\u2192 \u30BF\u30B9\u30AF\u7BA1\u7406\nhttps://web-production-b2798.up.railway.app/dashboard/tasks?token=${userId}`;
    return text.trim();
  } catch (err) {
    console.error("[briefing] noon error:", err);
    return "\u5348\u5F8C\u306E\u30D6\u30EA\u30FC\u30D5\u30A3\u30F3\u30B0\u306E\u751F\u6210\u306B\u5931\u6557\u3057\u307E\u3057\u305F\u3002";
  }
}

// ── Evening Briefing (21:00, Rule-based) ──

export async function generateEveningBriefing(userId: string): Promise<string> {
  try {
    const accounts = getGoogleAccountsByUserId(userId);
    const myEmails = accounts.map((a) => a.email).filter((e): e is string => e !== null);

    const [tomorrowEvents, tomorrowWeather, recentEmails] = await Promise.all([
      getTomorrowEvents(userId).catch(() => [] as CalendarEvent[]),
      getTomorrowWeatherSummary().catch(() => ""),
      getRecentEmails(userId, 14).catch(() => [] as Email[]),
    ]);

    let needsReplyCount = 0;
    for (const email of recentEmails) {
      if (needsReplyCount >= 5) break;
      const eveSubject = (email.subject ?? "").trim();
      const eveAutoSender = /no-?reply|noreply|newsletter|notifications?|donotreply|marketing|bounce/i.test(email.from);
      if (eveSubject === "" && eveAutoSender) continue;
      if (eveSubject === "Re:" && eveAutoSender) continue;
      const cat = await classifyEmailWithCache(email, userId, myEmails[0]).catch(() => "fyi" as const);
      if (cat !== "reply_later" && cat !== "urgent_reply") continue;
      const myReply = await checkMyReplyExists(email.threadId, userId, myEmails).catch(() => false);
      if (!myReply) needsReplyCount++;
    }

    let text = "\u304A\u75B2\u308C\u3055\u307E\u3067\u3057\u305F\u3002\n";

    if (needsReplyCount > 0) {
      text += `\n\u2501\u2501 \u4ECA\u65E5\u306E\u7A4D\u307F\u6B8B\u3057 \u2501\u2501\n`;
      text += `\u30FB\u672A\u8FD4\u4FE1\u30E1\u30FC\u30EB\u304C${needsReplyCount}\u4EF6\u3042\u308A\u307E\u3059\n`;
    }

    text += `\n\u2501\u2501 \u660E\u65E5\u306E\u4E88\u5B9A \u2501\u2501\n`;
    if (tomorrowEvents.length === 0) {
      text += "\u660E\u65E5\u306E\u4E88\u5B9A\u306F\u3042\u308A\u307E\u305B\u3093\u3002\n";
    } else {
      for (const e of tomorrowEvents) {
        text += `${fmtTime(e.start)} ${e.summary}`;
        if (e.location) text += ` @ ${e.location}`;
        text += "\n";
      }
    }

    if (tomorrowWeather) text += `\n${tomorrowWeather}\n`;

    text += `\n\u2192 \u30E1\u30FC\u30EB\u51E6\u7406\nhttps://web-production-b2798.up.railway.app/dashboard?token=${userId}\n\n\u2192 \u30BF\u30B9\u30AF\u7BA1\u7406\nhttps://web-production-b2798.up.railway.app/dashboard/tasks?token=${userId}\n`;

    text += "\n\u660E\u65E5\u3082\u3088\u3044\u4E00\u65E5\u3092\u3002";

    return text.trim();
  } catch (err) {
    console.error("[briefing] evening error:", err);
    return "\u591C\u306E\u30D6\u30EA\u30FC\u30D5\u30A3\u30F3\u30B0\u306E\u751F\u6210\u306B\u5931\u6557\u3057\u307E\u3057\u305F\u3002";
  }
}

// ── 直接実行で動作確認 ──
if (process.argv[1]?.endsWith("briefing.ts")) {
  const { initDb } = await import("../db/queries.js");
  await import("dotenv/config");
  initDb();

  const userId = process.env["LINE_USER_ID"] || "default";
  console.log("=== \u30D6\u30EA\u30FC\u30D5\u30A3\u30F3\u30B0\u751F\u6210\u4E2D... ===\n");
  const text = await generateBriefing(userId);
  console.log(text);
}
