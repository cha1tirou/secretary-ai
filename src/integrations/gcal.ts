import { google } from "googleapis";
import { getAuthedClient, ReauthRequiredError } from "./auth.js";
import { GoogleApiError } from "./errors.js";
import { getGoogleAccountsByUserId } from "../db/queries.js";
import type { CalendarEvent } from "../types.js";
import type { GoogleAccount } from "../types.js";

function wrapGoogleError(err: unknown, userId: string): never {
  if (err instanceof ReauthRequiredError) throw err;
  if (err instanceof GoogleApiError) throw err;
  const msg = err instanceof Error ? err.message : String(err);
  const status = (err as any)?.code ?? (err as any)?.status ?? 0;
  throw new GoogleApiError(userId, msg, Number(status));
}

async function getCalendarClient(userId: string, account?: GoogleAccount) {
  const auth = await getAuthedClient(userId, "gcalToken", account);
  return google.calendar({ version: "v3", auth });
}

function toCalendarEvent(item: any): CalendarEvent {
  return {
    id: item.id ?? "",
    summary: item.summary ?? "(無題)",
    description: item.description ?? "",
    start: item.start?.dateTime ?? item.start?.date ?? "",
    end: item.end?.dateTime ?? item.end?.date ?? "",
    location: item.location ?? "",
  };
}

async function getTodayEventsForAccount(
  userId: string,
  account?: GoogleAccount,
): Promise<CalendarEvent[]> {
  const calendar = await getCalendarClient(userId, account);

  const now = new Date();
  const startOfDay = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const endOfDay = new Date(startOfDay.getTime() + 24 * 60 * 60 * 1000);

  const res = await calendar.events.list({
    calendarId: "primary",
    timeMin: startOfDay.toISOString(),
    timeMax: endOfDay.toISOString(),
    singleEvents: true,
    orderBy: "startTime",
  });

  return (res.data.items ?? [])
    .map(toCalendarEvent)
    .filter((e) => {
      const eventStart = new Date(e.start).getTime();
      return eventStart >= startOfDay.getTime();
    });
}

export async function getTodayEvents(userId: string): Promise<CalendarEvent[]> {
  console.log(`[gcal] getTodayEvents: userId="${userId}"`);
  const accounts = getGoogleAccountsByUserId(userId);

  try {
    if (accounts.length === 0) {
      const events = await getTodayEventsForAccount(userId);
      console.log(`[gcal] getTodayEvents: ${events.length} events`);
      return events;
    }

    const results = await Promise.allSettled(
      accounts.map((acc) => getTodayEventsForAccount(userId, acc)),
    );

    const events: CalendarEvent[] = [];
    const seenIds = new Set<string>();
    for (const result of results) {
      if (result.status === "fulfilled") {
        for (const event of result.value) {
          if (!seenIds.has(event.id)) {
            seenIds.add(event.id);
            events.push(event);
          }
        }
      } else {
        console.error("[gcal] アカウント取得エラー:", result.reason);
      }
    }

    // 開始時刻順にソート
    events.sort((a, b) => new Date(a.start).getTime() - new Date(b.start).getTime());
    console.log(`[gcal] getTodayEvents: ${events.length} events (${accounts.length} accounts)`);
    return events;
  } catch (err) {
    console.error("[gcal] getTodayEvents エラー:", err);
    wrapGoogleError(err, userId);
  }
}

async function getTomorrowEventsForAccount(
  userId: string,
  account?: GoogleAccount,
): Promise<CalendarEvent[]> {
  const calendar = await getCalendarClient(userId, account);

  const now = new Date();
  const startOfTomorrow = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1);
  const endOfTomorrow = new Date(startOfTomorrow.getTime() + 24 * 60 * 60 * 1000);

  const res = await calendar.events.list({
    calendarId: "primary",
    timeMin: startOfTomorrow.toISOString(),
    timeMax: endOfTomorrow.toISOString(),
    singleEvents: true,
    orderBy: "startTime",
  });

  return (res.data.items ?? []).map(toCalendarEvent);
}

export async function getTomorrowEvents(userId: string): Promise<CalendarEvent[]> {
  try {
    const accounts = getGoogleAccountsByUserId(userId);

    if (accounts.length === 0) {
      return await getTomorrowEventsForAccount(userId);
    }

    const results = await Promise.allSettled(
      accounts.map((acc) => getTomorrowEventsForAccount(userId, acc)),
    );

    const events: CalendarEvent[] = [];
    const seenIds = new Set<string>();
    for (const result of results) {
      if (result.status === "fulfilled") {
        for (const event of result.value) {
          if (!seenIds.has(event.id)) {
            seenIds.add(event.id);
            events.push(event);
          }
        }
      }
    }

    events.sort((a, b) => new Date(a.start).getTime() - new Date(b.start).getTime());
    return events;
  } catch (err) {
    wrapGoogleError(err, userId);
  }
}

async function getWeekEventsForAccount(
  userId: string,
  account?: GoogleAccount,
): Promise<CalendarEvent[]> {
  const calendar = await getCalendarClient(userId, account);

  const now = new Date();
  const startOfDay = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const endOfWeek = new Date(startOfDay.getTime() + 7 * 24 * 60 * 60 * 1000);

  const res = await calendar.events.list({
    calendarId: "primary",
    timeMin: startOfDay.toISOString(),
    timeMax: endOfWeek.toISOString(),
    singleEvents: true,
    orderBy: "startTime",
  });

  return (res.data.items ?? []).map(toCalendarEvent);
}

export async function getWeekEvents(userId: string): Promise<CalendarEvent[]> {
  try {
    const accounts = getGoogleAccountsByUserId(userId);

    if (accounts.length === 0) {
      return await getWeekEventsForAccount(userId);
    }

    const results = await Promise.allSettled(
      accounts.map((acc) => getWeekEventsForAccount(userId, acc)),
    );

    const events: CalendarEvent[] = [];
    const seenIds = new Set<string>();
    for (const result of results) {
      if (result.status === "fulfilled") {
        for (const event of result.value) {
          if (!seenIds.has(event.id)) {
            seenIds.add(event.id);
            events.push(event);
          }
        }
      }
    }

    events.sort((a, b) => new Date(a.start).getTime() - new Date(b.start).getTime());
    return events;
  } catch (err) {
    wrapGoogleError(err, userId);
  }
}

async function getMonthEventsForAccount(
  userId: string,
  account?: GoogleAccount,
): Promise<CalendarEvent[]> {
  const calendar = await getCalendarClient(userId, account);

  const now = new Date();
  const start = new Date(now.getFullYear(), now.getMonth(), 1);
  const end = new Date(now.getFullYear(), now.getMonth() + 1, 0, 23, 59, 59);

  const res = await calendar.events.list({
    calendarId: "primary",
    timeMin: start.toISOString(),
    timeMax: end.toISOString(),
    singleEvents: true,
    orderBy: "startTime",
  });

  return (res.data.items ?? []).map(toCalendarEvent);
}

export async function getMonthEvents(userId: string): Promise<CalendarEvent[]> {
  try {
    const accounts = getGoogleAccountsByUserId(userId);

    if (accounts.length === 0) {
      return await getMonthEventsForAccount(userId);
    }

    const results = await Promise.allSettled(
      accounts.map((acc) => getMonthEventsForAccount(userId, acc)),
    );

    const events: CalendarEvent[] = [];
    const seenIds = new Set<string>();
    for (const result of results) {
      if (result.status === "fulfilled") {
        for (const event of result.value) {
          if (!seenIds.has(event.id)) {
            seenIds.add(event.id);
            events.push(event);
          }
        }
      }
    }

    events.sort((a, b) => new Date(a.start).getTime() - new Date(b.start).getTime());
    return events;
  } catch (err) {
    wrapGoogleError(err, userId);
  }
}

export async function createEvent(
  userId: string,
  params: { title: string; start: string; end: string; location?: string; description?: string },
): Promise<CalendarEvent> {
  try {
    const accounts = getGoogleAccountsByUserId(userId);
    const account = accounts.length > 0 ? accounts[0] : undefined;
    const calendar = await getCalendarClient(userId, account);

    const requestBody: Record<string, unknown> = {
      summary: params.title,
      start: { dateTime: params.start, timeZone: "Asia/Tokyo" },
      end: { dateTime: params.end, timeZone: "Asia/Tokyo" },
    };
    if (params.location) requestBody["location"] = params.location;
    if (params.description) requestBody["description"] = params.description;

    const res = await calendar.events.insert({
      calendarId: "primary",
      requestBody,
    });

    return toCalendarEvent(res.data);
  } catch (err) {
    wrapGoogleError(err, userId);
  }
}

// ── 直接実行で動作確認 ──
if (process.argv[1]?.endsWith("gcal.ts")) {
  const { initDb } = await import("../db/queries.js");
  await import("dotenv/config");
  initDb();

  const userId = process.env["LINE_USER_ID"] || "default";

  console.log("=== 今日の予定 ===");
  const today = await getTodayEvents(userId);
  if (today.length === 0) {
    console.log("  予定なし");
  } else {
    for (const e of today) {
      console.log(`  ${e.start} - ${e.end}: ${e.summary} (${e.location || "場所なし"})`);
    }
  }

  console.log("\n=== 今週の予定 ===");
  const week = await getWeekEvents(userId);
  if (week.length === 0) {
    console.log("  予定なし");
  } else {
    for (const e of week) {
      console.log(`  ${e.start} - ${e.end}: ${e.summary}`);
    }
  }
}
