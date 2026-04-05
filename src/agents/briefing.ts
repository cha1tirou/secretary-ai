import Anthropic from "@anthropic-ai/sdk";
import { getTodayEvents, getTomorrowEvents } from "../integrations/gcal.js";
import { getUnreadEmails, getSentEmails, checkThreadReplied } from "../integrations/gmail.js";
import { getWeatherSummary, getTomorrowWeatherSummary } from "../integrations/weather.js";
import { getGoogleAccountsByUserId, countProcessedEmailsByCategory, getProcessedEmailsByCategory } from "../db/queries.js";
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

// ── Types ──

type MorningContext = {
  weather: string;
  events: CalendarEvent[];
  emails: Email[];
  unrepliedSent: { from: string; subject: string; daysAgo: number }[];
  actionNeededSubjects: string[];
  newsletterCount: number;
};

// ── Morning Briefing (8:00, Haiku) ──

async function buildMorningContext(userId: string): Promise<MorningContext> {
  const accounts = getGoogleAccountsByUserId(userId);
  const myEmails = accounts.map((a) => a.email).filter((e): e is string => e !== null);

  const [weather, events, emails, sentEmails] = await Promise.all([
    getWeatherSummary().catch(() => ""),
    getTodayEvents(userId).catch(() => [] as CalendarEvent[]),
    getUnreadEmails(userId).catch(() => [] as Email[]),
    getSentEmails(userId, 20).catch(() => [] as Email[]),
  ]);

  // 未返信メール検出（3日以上）
  const unrepliedSent: MorningContext["unrepliedSent"] = [];
  const threeDaysAgo = Date.now() - 3 * 86400000;
  for (const sent of sentEmails) {
    const sentDate = new Date(sent.date).getTime();
    if (sentDate > threeDaysAgo) continue;
    const replied = await checkThreadReplied(sent.threadId, userId, myEmails).catch(() => true);
    if (!replied) {
      const daysAgo = Math.floor((Date.now() - sentDate) / 86400000);
      unrepliedSent.push({ from: fmtFrom(sent.to), subject: sent.subject, daysAgo });
    }
    if (unrepliedSent.length >= 5) break;
  }

  const todayStart = new Date();
  todayStart.setHours(0, 0, 0, 0);
  const since = todayStart.toISOString();

  const actionRows = getProcessedEmailsByCategory(userId, "action_needed", since);
  const actionNeededSubjects: string[] = [];
  for (const row of actionRows) {
    const match = emails.find((e) => e.id === row.messageId);
    if (match) actionNeededSubjects.push(match.subject);
  }

  const newsletterCount = countProcessedEmailsByCategory(userId, "newsletter", since);

  return { weather, events, emails, unrepliedSent, actionNeededSubjects, newsletterCount };
}

function buildMorningPrompt(ctx: MorningContext): string {
  const eventSection = ctx.events.length === 0
    ? "\u4ECA\u65E5\u306E\u4E88\u5B9A\u306F\u3042\u308A\u307E\u305B\u3093\u3002"
    : ctx.events.map((e) => {
        const loc = e.location ? ` (${e.location})` : "";
        return `- ${fmtTime(e.start)} ${e.summary}${loc}`;
      }).join("\n");

  const concerns: string[] = [];
  for (const s of ctx.actionNeededSubjects) concerns.push(`\u26A0\uFE0F ${s}`);
  for (const u of ctx.unrepliedSent) concerns.push(`\u26A0\uFE0F ${u.from}\u300C${u.subject}\u300D\u2190 ${u.daysAgo}\u65E5\u8FD4\u4FE1\u306A\u3057`);

  const emailSection = ctx.emails.length === 0
    ? "\u672A\u8AAD\u30E1\u30FC\u30EB\u306F\u3042\u308A\u307E\u305B\u3093\u3002"
    : ctx.emails.slice(0, 5).map((e) => `- ${fmtFrom(e.from)}: ${e.subject}`).join("\n");

  return `\u3042\u306A\u305F\u306FLINE\u3067\u52D5\u304FAI\u79D8\u66F8\u3067\u3059\u3002\u4EE5\u4E0B\u306E\u60C5\u5831\u3092\u3082\u3068\u306B\u3001\u671D\u306E\u30D6\u30EA\u30FC\u30D5\u30A3\u30F3\u30B0\u3092\u4F5C\u6210\u3057\u3066\u304F\u3060\u3055\u3044\u3002

## \u30EB\u30FC\u30EB
- LINE\u3067\u8AAD\u307F\u3084\u3059\u3044\u7C21\u6F54\u306A\u5F62\u5F0F
- 1000\u6587\u5B57\u4EE5\u5185
- \u4EE5\u4E0B\u306E\u5F62\u5F0F\u3092\u53C2\u8003\u306B\u3059\u308B

## \u5929\u6C17
${ctx.weather || "\u60C5\u5831\u306A\u3057"}

## \u4ECA\u65E5\u306E\u4E88\u5B9A
${eventSection}

## \u6C17\u306B\u306A\u308B\u3053\u3068
${concerns.length === 0 ? "\u306A\u3057" : concerns.join("\n")}

## \u672A\u8AAD\u30E1\u30FC\u30EB (${ctx.emails.length}\u4EF6)
${emailSection}`;
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

  // 気になること
  const concerns: string[] = [];
  for (const s of ctx.actionNeededSubjects) concerns.push(`\u26A0\uFE0F ${s}`);
  for (const u of ctx.unrepliedSent) concerns.push(`\u26A0\uFE0F ${u.from}\u300C${u.subject}\u300D\u2190 ${u.daysAgo}\u65E5\u7D4C\u904E`);
  if (concerns.length > 0) {
    text += `\n\u2501\u2501 \u6C17\u306B\u306A\u308B\u3053\u3068 \u2501\u2501\n`;
    text += concerns.join("\n") + "\n";
  }

  text += `\n\u2501\u2501 \u672A\u8AAD\u30E1\u30FC\u30EB \u2501\u2501\n`;
  if (ctx.emails.length === 0) {
    text += "\u672A\u8AAD\u30E1\u30FC\u30EB\u306F\u3042\u308A\u307E\u305B\u3093\u3002\n";
  } else {
    text += `${ctx.emails.length}\u4EF6\u306E\u672A\u8AAD\u30E1\u30FC\u30EB\u304C\u3042\u308A\u307E\u3059\u3002\n`;
    for (const e of ctx.emails.slice(0, 5)) {
      text += `\u30FB${fmtFrom(e.from)}: ${e.subject}\n`;
    }
    if (ctx.emails.length > 5) text += `\u2026\u4ED6${ctx.emails.length - 5}\u4EF6\n`;
  }

  return text.trim();
}

export async function generateBriefing(userId: string): Promise<string> {
  const ctx = await buildMorningContext(userId);
  const dashboardLink = `\n\n\u2192 \u30E1\u30FC\u30EB\u51E6\u7406\u306F\u30C0\u30C3\u30B7\u30E5\u30DC\u30FC\u30C9\u304B\u3089\nhttps://web-production-b2798.up.railway.app/dashboard?token=${userId}`;

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

    const emails = await getUnreadEmails(userId).catch(() => [] as Email[]);
    if (emails.length > 0) {
      text += `\n\u2501\u2501 \u6C17\u306B\u306A\u308B\u3053\u3068 \u2501\u2501\n`;
      text += `\u30FB\u672A\u5BFE\u5FDC\u30E1\u30FC\u30EB\u304C${emails.length}\u4EF6\u3042\u308A\u307E\u3059\n`;
    }

    text += `\n\u2192 \u30C0\u30C3\u30B7\u30E5\u30DC\u30FC\u30C9\u3067\u78BA\u8A8D\nhttps://web-production-b2798.up.railway.app/dashboard?token=${userId}`;

    return text.trim();
  } catch (err) {
    console.error("[briefing] noon error:", err);
    return "\u5348\u5F8C\u306E\u30D6\u30EA\u30FC\u30D5\u30A3\u30F3\u30B0\u306E\u751F\u6210\u306B\u5931\u6557\u3057\u307E\u3057\u305F\u3002";
  }
}

// ── Evening Briefing (21:00, Rule-based) ──

export async function generateEveningBriefing(userId: string): Promise<string> {
  try {
    const [emails, tomorrowEvents, tomorrowWeather] = await Promise.all([
      getUnreadEmails(userId).catch(() => [] as Email[]),
      getTomorrowEvents(userId).catch(() => [] as CalendarEvent[]),
      getTomorrowWeatherSummary().catch(() => ""),
    ]);

    let text = "\u304A\u75B2\u308C\u3055\u307E\u3067\u3057\u305F\u3002\n";

    if (emails.length > 0) {
      text += `\n\u2501\u2501 \u4ECA\u65E5\u306E\u7A4D\u307F\u6B8B\u3057 \u2501\u2501\n`;
      text += `\u30FB\u672A\u5BFE\u5FDC\u30E1\u30FC\u30EB\u304C${emails.length}\u4EF6\u3042\u308A\u307E\u3059\n`;
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

    if (emails.length > 0) {
      text += `\n\u2192 \u7A4D\u307F\u6B8B\u3057\u306F\u30C0\u30C3\u30B7\u30E5\u30DC\u30FC\u30C9\u304B\u3089\nhttps://web-production-b2798.up.railway.app/dashboard?token=${userId}\n`;
    }

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
