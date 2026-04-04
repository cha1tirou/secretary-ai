import { google } from "googleapis";
import { getAuthedClient } from "./auth.js";
import type { CalendarEvent } from "../types.js";

async function getCalendarClient(userId: string) {
  const auth = await getAuthedClient(userId, "gcalToken");
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

export async function getTodayEvents(userId: string): Promise<CalendarEvent[]> {
  console.log(`[gcal] getTodayEvents: userId="${userId}"`);
  try {
    const calendar = await getCalendarClient(userId);

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
    // 開始時刻が今日のものだけに絞る（日またぎ予定を除外）
    const events = (res.data.items ?? [])
      .map(toCalendarEvent)
      .filter((e) => {
        const eventStart = new Date(e.start).getTime();
        return eventStart >= startOfDay.getTime();
      });
    console.log(`[gcal] getTodayEvents: ${events.length} events (raw: ${res.data.items?.length ?? 0})`);

    return events;
  } catch (err) {
    console.error("[gcal] getTodayEvents エラー:", err);
    throw err;
  }
}

export async function getWeekEvents(userId: string): Promise<CalendarEvent[]> {
  const calendar = await getCalendarClient(userId);

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

export async function createEvent(
  userId: string,
  params: { title: string; start: string; end: string; location?: string; description?: string },
): Promise<CalendarEvent> {
  const calendar = await getCalendarClient(userId);

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
