import Anthropic from "@anthropic-ai/sdk";
import type { Tool, MessageParam, ContentBlockParam, ToolResultBlockParam, ToolUseBlock } from "@anthropic-ai/sdk/resources/messages.js";
import { getTodayEvents, getWeekEvents, getMonthEvents, createEvent } from "../integrations/gcal.js";
import { getUnreadEmails, getAllEmails, getThread, sendReply } from "../integrations/gmail.js";
import {
  getUser,
  getTasks,
  createTask,
  updateTaskStatus,
  getPendingRepliesByStatus,
  createPendingReply,
  addConversation,
  getRecentConversations,
  updateUserPlan,
  getTrialDaysRemaining,
  getGoogleAccountsByUserId,
  checkUsageLimit,
  logUsage,
  getResetDate,
  USAGE_LIMITS,
} from "../db/queries.js";
import { checkAndNotifyUsageAlert } from "../utils/usage.js";
import { ReauthRequiredError, buildAuthUrl } from "../integrations/auth.js";
import { GoogleApiError } from "../integrations/errors.js";
import type { Plan } from "../types.js";
import type { CalendarEvent } from "../types.js";

const isDev = process.env["NODE_ENV"] === "development";

function googleReauthMessage(userId: string): string {
  return `Google連携の認証が切れました。再連携が必要です。\n👇 こちらからどうぞ\n${buildAuthUrl(userId)}`;
}

function classifyError(err: unknown, userId: string): string {
  const msg = err instanceof Error ? err.message : String(err);

  // Google API 再認証系
  if (err instanceof ReauthRequiredError) {
    return googleReauthMessage(userId);
  }
  if (err instanceof GoogleApiError) {
    if (/invalid_grant|Token has been expired|Token has been revoked/i.test(msg)) {
      return googleReauthMessage(userId);
    }
    if (/insufficient_permission|forbidden/i.test(msg) || err.status === 403) {
      return `Gmailへのアクセス権限がありません。再連携で権限を許可してください。\n👇 ${buildAuthUrl(userId)}`;
    }
    return "データの取得中にエラーが発生しました。しばらくしてから再度お試しください。";
  }

  // Anthropic API 系
  if (/credit balance/i.test(msg)) {
    return "システムエラーが発生しました。しばらくしてから再度お試しください。";
  }
  if (/rate_limit/i.test(msg) || (err instanceof Anthropic.APIError && err.status === 429)) {
    return "ただいま処理が混み合っています。1分ほど待ってからお試しください。";
  }
  if (/not_found_error/i.test(msg)) {
    return "システムエラーが発生しました。しばらくしてから再度お試しください。";
  }

  return "エラーが発生しました。しばらくしてから再度お試しください。";
}

// ── コスト最適化 ──
// simple_command: Sonnet不使用、コード処理のみ（約0.04円/回）
// complex_request: Sonnet + Tool Use（約1.5〜4.5円/回）
// ループ最大3回でコスト上限設定
//
// ── NODE_ENV別動作 ──
// development:
//   simple_command → 実データ（DB/API）で固定処理
//   complex_request → Sonnet呼び出し（Gmail/Calendar APIは実データ）
// production:
//   simple_command → 実データで固定処理
//   complex_request → Sonnet呼び出し（実データ）
// ※ devでもSonnet自体は呼ぶ（Tool Use検証のため）。API未設定時のみモック。

// ── Simple Command (regex, no LLM) ──

type SimpleCommand =
  | { type: "today_schedule" }
  | { type: "week_schedule" }
  | { type: "month_schedule" }
  | { type: "free_time" }
  | { type: "unread_email" }
  | { type: "task_list" }
  | { type: "task_add"; title: string }
  | { type: "task_done"; raw: string }
  | { type: "hold_list" }
  | { type: "dashboard" };

function matchSimpleCommand(text: string): SimpleCommand | null {
  if (/今日の予定|今日どんな|今日何がある/.test(text)) return { type: "today_schedule" };
  if (/今週の予定|週間|今週どんな/.test(text)) return { type: "week_schedule" };
  if (/今月の予定|今月のスケジュール|今月は何がある/.test(text)) return { type: "month_schedule" };
  if (/空いてる|空き時間|いつ空いてる/.test(text)) return { type: "free_time" };
  // 「返信すべき」「要返信」系はダッシュボードに誘導
  if (/返信すべき|要返信|返信が必要|返さないと|返信.*メール.*ある|メール.*返信/.test(text)) return { type: "dashboard" };
  if (/未読|メール来てる|メールチェック/.test(text) && !/重要|急ぎ|至急|大事|優先/.test(text)) return { type: "unread_email" };

  const taskAddMatch = text.match(/(.+?)をタスクに/) || ((/タスクに追加/.test(text)) ? [null, text.replace(/タスクに追加|して|を/g, "").trim()] : null);
  if (taskAddMatch?.[1]) return { type: "task_add", title: taskAddMatch[1].trim() };

  if (/完了|終わった|やった/.test(text) && /タスク|\d/.test(text)) return { type: "task_done", raw: text };
  if (/タスク|やること|todo/i.test(text)) return { type: "task_list" };
  if (/保留|保留メール/.test(text)) return { type: "hold_list" };
  if (/ダッシュボード|メール処理|メール作業|返信まとめ/.test(text)) return { type: "dashboard" };

  return null;
}

// ── Formatters ──

function fmtTime(iso: string): string {
  if (!iso.includes("T")) return "終日";
  return new Date(iso).toLocaleTimeString("ja-JP", { hour: "2-digit", minute: "2-digit" });
}

function fmtEvents(events: CalendarEvent[]): string {
  if (events.length === 0) return "予定はありません。";
  return events.map((e) => {
    const loc = e.location ? ` (${e.location})` : "";
    return `・${fmtTime(e.start)} ${e.summary}${loc}`;
  }).join("\n");
}

function fmtGroupedEvents(events: CalendarEvent[], emptyMsg = "予定はありません。"): string {
  if (events.length === 0) return emptyMsg;
  const days = ["日", "月", "火", "水", "木", "金", "土"];
  const grouped = new Map<string, CalendarEvent[]>();
  for (const e of events) {
    const d = new Date(e.start);
    const key = `${d.getMonth() + 1}/${d.getDate()}(${days[d.getDay()]})`;
    if (!grouped.has(key)) grouped.set(key, []);
    grouped.get(key)!.push(e);
  }
  let text = "";
  for (const [day, evts] of grouped) {
    text += `\n${day}\n`;
    text += evts.map((e) => `　${fmtTime(e.start)} ${e.summary}`).join("\n");
  }
  return text.trim();
}

function calcFreeSlots(events: CalendarEvent[]): string {
  const days = ["日", "月", "火", "水", "木", "金", "土"];
  const now = new Date();
  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate());

  let text = "";
  let hasSlot = false;

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
      text += `\n${dayLabel}: 終日空き`;
      hasSlot = true;
      continue;
    }

    const slots: string[] = [];
    let cursor = 9 * 60;
    for (const e of dayEvents) {
      if (!e.start.includes("T")) continue;
      const sMin = new Date(e.start).getHours() * 60 + new Date(e.start).getMinutes();
      const eMin = new Date(e.end).getHours() * 60 + new Date(e.end).getMinutes();
      if (sMin - cursor >= 60) {
        slots.push(`${String(Math.floor(cursor / 60)).padStart(2, "0")}:${String(cursor % 60).padStart(2, "0")}〜${String(Math.floor(sMin / 60)).padStart(2, "0")}:${String(sMin % 60).padStart(2, "0")}`);
      }
      cursor = Math.max(cursor, eMin);
    }
    if (19 * 60 - cursor >= 60) {
      slots.push(`${String(Math.floor(cursor / 60)).padStart(2, "0")}:${String(cursor % 60).padStart(2, "0")}〜19:00`);
    }

    text += `\n${dayLabel}: ${slots.length > 0 ? slots.join(", ") : "空きなし"}`;
    if (slots.length > 0) hasSlot = true;
  }

  if (!hasSlot) text += "\n今週の平日は空きがありません。";
  return text.trim();
}

// ── Simple Command Executor ──

async function execSimpleCommand(cmd: SimpleCommand, userId: string): Promise<string> {
  switch (cmd.type) {
    case "today_schedule": {
      const events = await getTodayEvents(userId);
      return `今日の予定（${events.length}件）\n${fmtEvents(events)}`;
    }
    case "week_schedule": {
      const events = await getWeekEvents(userId);
      return `今週の予定（${events.length}件）\n${fmtGroupedEvents(events, "\u4ECA\u9031\u306E\u4E88\u5B9A\u306F\u3042\u308A\u307E\u305B\u3093\u3002")}`;
    }
    case "month_schedule": {
      const events = await getMonthEvents(userId);
      const header = events.length > 10
        ? `今月の予定（${events.length}件あります。最初の10件）`
        : `今月の予定（${events.length}件）`;
      const display = events.slice(0, 10);
      return `${header}\n${fmtGroupedEvents(display, "\u4ECA\u6708\u306E\u4E88\u5B9A\u306F\u3042\u308A\u307E\u305B\u3093\u3002")}`;
    }
    case "free_time": {
      const events = await getWeekEvents(userId);
      return `今週の空き時間（9:00〜19:00）\n${calcFreeSlots(events)}`;
    }
    case "unread_email": {
      const emails = await getUnreadEmails(userId);
      if (emails.length === 0) return "未読メールはありません。";
      let text = `未読メール（${emails.length}件）`;
      for (const e of emails.slice(0, 10)) {
        const from = (e.from.split("<")[0] ?? "").trim() || e.from;
        text += `\n\n・${from}\n　${e.subject}`;
      }
      return text;
    }
    case "task_list": {
      const tasks = getTasks(userId, "todo");
      const baseUrl = "https://web-production-b2798.up.railway.app";
      const tasksUrl = `${baseUrl}/dashboard/tasks?token=${userId}`;
      if (tasks.length === 0) return `\u30BF\u30B9\u30AF\u306F\u3042\u308A\u307E\u305B\u3093\u3002\n\n\u2192 \u30BF\u30B9\u30AF\u7BA1\u7406\n${tasksUrl}`;
      let text = `\u30BF\u30B9\u30AF\u4E00\u89A7\uFF08${tasks.length}\u4EF6\uFF09`;
      for (const [i, t] of tasks.entries()) {
        const due = t.dueDate ? `\uFF08\u671F\u65E5: ${t.dueDate}\uFF09` : "";
        text += `\n${i + 1}. ${t.title}${due}`;
      }
      text += `\n\n\u2192 \u8FFD\u52A0\u30FB\u7DE8\u96C6\u30FB\u5B8C\u4E86\u306F\u3053\u3061\u3089\n${tasksUrl}`;
      return text;
    }
    case "task_add": {
      createTask(userId, cmd.title);
      const tasksUrl = `https://web-production-b2798.up.railway.app/dashboard/tasks?token=${userId}`;
      return `\u30BF\u30B9\u30AF\u306B\u8FFD\u52A0\u3057\u307E\u3057\u305F: ${cmd.title}\n\n\u2192 \u30BF\u30B9\u30AF\u4E00\u89A7\u306F\u3053\u3061\u3089\n${tasksUrl}`;
    }
    case "task_done": {
      const numMatch = cmd.raw.match(/(\d+)/);
      if (!numMatch) return "完了にするタスクの番号を教えてください。「タスク見せて」で確認できます。";
      const tasks = getTasks(userId, "todo");
      const idx = Number(numMatch[1]) - 1;
      const task = tasks[idx];
      if (!task) return "\u8A72\u5F53\u3059\u308B\u30BF\u30B9\u30AF\u304C\u898B\u3064\u304B\u308A\u307E\u305B\u3093\u3002\u30BF\u30B9\u30AF\u756A\u53F7\u3092\u78BA\u8A8D\u3057\u3066\u304F\u3060\u3055\u3044\u3002";
      updateTaskStatus(task.id, "done");
      return `完了にしました: ${task.title}`;
    }
    case "hold_list": {
      const holds = getPendingRepliesByStatus(userId, "hold");
      const pendings = getPendingRepliesByStatus(userId, "pending");
      const all = [...holds, ...pendings];
      if (all.length === 0) return "保留中の返信案はありません。";
      let text = `保留中の返信案（${all.length}件）`;
      for (const p of all.slice(0, 10)) {
        const label = p.status === "hold" ? "保留" : "未対応";
        text += `\n#${p.id} [${label}] ${p.subject}`;
      }
      text += "\n\n操作: 「送信 #番号」「キャンセル #番号」";
      return text;
    }
    case "dashboard": {
      const baseUrl = "https://web-production-b2798.up.railway.app";
      return `\uD83D\uDCEC \u30C0\u30C3\u30B7\u30E5\u30DC\u30FC\u30C9\u306F\u3053\u3061\u3089\u304B\u3089\u958B\u3051\u307E\u3059\u3002\n\n\u3010\u30E1\u30FC\u30EB\u51E6\u7406\u3011\n${baseUrl}/dashboard?token=${userId}\n\n\u3010\u30BF\u30B9\u30AF\u7BA1\u7406\u3011\n${baseUrl}/dashboard/tasks?token=${userId}`;
    }
  }
}

// ── Tool Definitions ──

const TOOLS: Tool[] = [
  {
    name: "get_today_events",
    description: "今日の予定を取得する",
    input_schema: { type: "object" as const, properties: {}, required: [] },
  },
  {
    name: "get_week_events",
    description: "今週の予定を取得する",
    input_schema: { type: "object" as const, properties: {}, required: [] },
  },
  {
    name: "get_month_events",
    description: "今月の予定を取得する",
    input_schema: { type: "object" as const, properties: {}, required: [] },
  },
  {
    name: "get_free_slots",
    description: "今週の空き時間を計算する（平日9:00-19:00、1時間以上の空き枠）",
    input_schema: { type: "object" as const, properties: {}, required: [] },
  },
  {
    name: "create_calendar_event",
    description: "カレンダーに予定を追加する。必ずユーザーに確認してから呼ぶこと。",
    input_schema: {
      type: "object" as const,
      properties: {
        title: { type: "string", description: "予定名" },
        start: { type: "string", description: "開始日時 ISO8601 (例: 2026-04-05T14:00:00)" },
        end: { type: "string", description: "終了日時 ISO8601" },
        location: { type: "string", description: "場所（任意）" },
        description: { type: "string", description: "メモ（任意）" },
      },
      required: ["title", "start", "end"],
    },
  },
  {
    name: "get_emails",
    description: "メールを取得する。未読のみまたは最近の全メール（既読含む）を取得できる。返信が必要かどうかはあなたが本文・件名・差出人を見て判断する。",
    input_schema: {
      type: "object" as const,
      properties: {
        scope: { type: "string", enum: ["unread", "all"], description: "unread: 未読のみ / all: 既読含む最近50件" },
        max_results: { type: "number", description: "取得件数（デフォルト20）" },
      },
      required: ["scope"],
    },
  },
  {
    name: "get_tasks",
    description: "タスク一覧を取得する",
    input_schema: {
      type: "object" as const,
      properties: {
        status: { type: "string", enum: ["todo", "done", "all"], description: "フィルタ（デフォルト: todo）" },
      },
      required: [],
    },
  },
  {
    name: "create_task",
    description: "タスクを追加する",
    input_schema: {
      type: "object" as const,
      properties: {
        title: { type: "string", description: "タスク名" },
        due_date: { type: "string", description: "期日 YYYY-MM-DD（任意）" },
        description: { type: "string", description: "詳細（任意）" },
      },
      required: ["title"],
    },
  },
  {
    name: "update_task_status",
    description: "タスクのステータスを更新する",
    input_schema: {
      type: "object" as const,
      properties: {
        task_id: { type: "number", description: "タスクID" },
        status: { type: "string", enum: ["todo", "done", "cancelled"] },
      },
      required: ["task_id", "status"],
    },
  },
  {
    name: "get_hold_emails",
    description: "保留中のメール返信案一覧を取得する",
    input_schema: { type: "object" as const, properties: {}, required: [] },
  },
];

// ── Tool Executor ──

// dev時はGmail/Calendar APIの代わりにダミーデータを返す
function mockToolResult(name: string, input: Record<string, unknown>): string | null {
  if (!isDev) return null;

  switch (name) {
    case "get_today_events":
      return JSON.stringify([
        { summary: "チームMTG", start: "2026-04-04T10:00:00+09:00", end: "2026-04-04T11:00:00+09:00", location: "会議室A" },
        { summary: "クライアント打ち合わせ", start: "2026-04-04T14:00:00+09:00", end: "2026-04-04T15:30:00+09:00", location: "Zoom" },
        { summary: "1on1 田中さん", start: "2026-04-04T17:00:00+09:00", end: "2026-04-04T17:30:00+09:00", location: "" },
      ]);
    case "get_week_events":
      return JSON.stringify([
        { summary: "チームMTG", start: "2026-04-04T10:00:00+09:00", end: "2026-04-04T11:00:00+09:00", location: "会議室A" },
        { summary: "クライアント打ち合わせ", start: "2026-04-04T14:00:00+09:00", end: "2026-04-04T15:30:00+09:00", location: "Zoom" },
        { summary: "企画レビュー", start: "2026-04-07T13:00:00+09:00", end: "2026-04-07T14:00:00+09:00", location: "" },
        { summary: "全体会議", start: "2026-04-09T10:00:00+09:00", end: "2026-04-09T11:30:00+09:00", location: "大会議室" },
      ]);
    case "get_month_events":
      return JSON.stringify([
        { summary: "チームMTG", start: "2026-04-04T10:00:00+09:00", end: "2026-04-04T11:00:00+09:00", location: "会議室A" },
        { summary: "企画レビュー", start: "2026-04-07T13:00:00+09:00", end: "2026-04-07T14:00:00+09:00", location: "" },
        { summary: "全体会議", start: "2026-04-09T10:00:00+09:00", end: "2026-04-09T11:30:00+09:00", location: "大会議室" },
        { summary: "月次報告", start: "2026-04-15T15:00:00+09:00", end: "2026-04-15T16:00:00+09:00", location: "Zoom" },
        { summary: "懇親会", start: "2026-04-25T18:00:00+09:00", end: "2026-04-25T20:00:00+09:00", location: "渋谷" },
      ]);
    case "get_free_slots":
      return "4/4(金): 09:00〜10:00, 11:00〜14:00, 15:30〜17:00\n4/7(月): 09:00〜13:00, 14:00〜19:00\n4/8(火): 終日空き\n4/9(水): 09:00〜10:00, 11:30〜19:00\n4/10(木): 終日空き";
    case "create_calendar_event":
      return `予定を登録しました: ${input.title} (${input.start}〜${input.end})`;
    case "get_emails":
      return JSON.stringify([
        { id: "m1", from: "山田太郎 <yamada@example.com>", subject: "来週の企画書について", date: "2026-04-03 18:30", body: "お疲れ様です。来週の企画書の件ですが、金曜までにレビューをお願いできますか？", isUnread: true },
        { id: "m2", from: "佐藤花子 <sato@example.com>", subject: "月次レポート提出依頼", date: "2026-04-03 09:00", body: "月次レポートを4/10までにご提出ください。", isUnread: true },
        { id: "m3", from: "no-reply@example.com", subject: "ご注文の確認", date: "2026-04-02 22:00", body: "ご注文ありがとうございます。注文番号: 12345", isUnread: true },
        { id: "m4", from: "鈴木一郎 <suzuki@example.com>", subject: "日程調整のお願い", date: "2026-04-02 15:00", body: "来週のミーティングですが、ご都合いかがでしょうか？", isUnread: true },
      ]);
    default:
      return null; // DB操作系（tasks, hold_emails）はdevでも実データを使う
  }
}

async function executeTool(name: string, input: Record<string, unknown>, userId: string): Promise<string> {
  // dev時: Gmail/Calendar APIはダミー、DB操作は実データ
  const mock = mockToolResult(name, input);
  if (mock !== null) {
    console.log(`[secretary] tool mock: ${name}`);
    return mock;
  }

  switch (name) {
    case "get_today_events": {
      const events = await getTodayEvents(userId);
      return JSON.stringify(events.map((e) => ({ summary: e.summary, start: e.start, end: e.end, location: e.location })));
    }
    case "get_week_events": {
      const events = await getWeekEvents(userId);
      return JSON.stringify(events.map((e) => ({ summary: e.summary, start: e.start, end: e.end, location: e.location })));
    }
    case "get_month_events": {
      const events = await getMonthEvents(userId);
      return JSON.stringify(events.map((e) => ({ summary: e.summary, start: e.start, end: e.end, location: e.location })));
    }
    case "get_free_slots": {
      const events = await getWeekEvents(userId);
      return calcFreeSlots(events);
    }
    case "create_calendar_event": {
      const params: { title: string; start: string; end: string; location?: string; description?: string } = {
        title: input.title as string,
        start: input.start as string,
        end: input.end as string,
      };
      if (input.location) params.location = input.location as string;
      if (input.description) params.description = input.description as string;
      const created = await createEvent(userId, params);
      return `予定を登録しました: ${created.summary} (${created.start}〜${created.end})`;
    }
    case "get_emails": {
      const scope = input.scope as string;
      const max = (input.max_results as number) ?? 20;
      const emails = scope === "all"
        ? await getAllEmails(userId, max)
        : await getUnreadEmails(userId);
      return JSON.stringify(emails.slice(0, max).map((e) => ({
        id: e.id,
        from: e.from,
        subject: e.subject,
        date: e.date,
        body: e.body.slice(0, 200),
        isUnread: e.isUnread,
      })));
    }
    case "get_tasks": {
      const status = input.status as string | undefined;
      const tasks = status === "all" ? getTasks(userId) : getTasks(userId, (status as "todo" | "done") ?? "todo");
      return JSON.stringify(tasks.map((t) => ({ id: t.id, title: t.title, due_date: t.dueDate, status: t.status })));
    }
    case "create_task": {
      const id = createTask(userId, input.title as string, input.description as string | undefined, input.due_date as string | undefined);
      return `タスクを追加しました (ID: ${id}): ${input.title}`;
    }
    case "update_task_status": {
      updateTaskStatus(input.task_id as number, input.status as "todo" | "done" | "cancelled");
      return `タスク #${input.task_id} を ${input.status} に更新しました`;
    }
    case "get_hold_emails": {
      const holds = getPendingRepliesByStatus(userId, "hold");
      const pendings = getPendingRepliesByStatus(userId, "pending");
      return JSON.stringify([...holds, ...pendings].map((p) => ({
        id: p.id, subject: p.subject, to: p.toAddress, status: p.status,
        draft: p.draftContent.slice(0, 100),
      })));
    }
    default:
      return `Unknown tool: ${name}`;
  }
}

// ── System Prompt ──

function buildSystemPrompt(userId: string): string {
  const today = new Date().toLocaleDateString("ja-JP", {
    weekday: "long", year: "numeric", month: "long", day: "numeric",
  });
  const dashboardUrl = `https://web-production-b2798.up.railway.app/dashboard?token=${userId}`;
  return `あなたは優秀なAI秘書です。今日: ${today}
ルール：
- 日本語で簡潔に回答する
- メール送信・カレンダー登録前は必ずユーザーに確認を取る
- 返答は簡潔に。リスト形式の場合は全件表示する。通常の会話は200文字以内を目安にする
- 日時は〇月〇日（曜日）HH:MM形式で表記する

メール判断ルール：
- メールの返信要否はget_emailsで取得してから、本文・件名・差出人を見てあなたが判断する
- 「返信すべきメール」「要返信メール」と聞かれたら、以下のテキストをそのまま返す：
  「返信が必要なメールはダッシュボードで確認・処理できます。\n${dashboardUrl}」
- get_emailsで取得したメールのうち、返信が必要と判断したもの（質問・依頼・日程調整・確認依頼など）だけを返す
- 返信不要なもの（お知らせ・領収書・自動送信・no-reply）は除外する
- 今月の予定を聞かれたらget_month_eventsツールを使う

タスク管理ルール：
- タスクの確認・編集・完了を求められたらダッシュボードURLを案内する
  URL: https://web-production-b2798.up.railway.app/dashboard/tasks?token=${userId}`;
}

// ── Plan Messages ──

const EXPIRED_MESSAGE = `7日間の無料体験が終了しました。

ご利用プランを選択してください：

ライトプラン 480円/月
・毎朝のブリーフィング
・メール自動分類・通知
・定型コマンド（予定確認・タスク管理・メール一覧）

プロプラン 980円/月
・ライトの全機能
・AIとの自由な対話
・自然言語でのカレンダー登録
・複合的なリクエスト対応

※決済機能は近日公開予定です。それまでの間は引き続き全機能をお使いいただけます。`;

// ── Plan Check ──

function checkPlan(userId: string): { plan: Plan; trialWarning?: string } {
  const user = getUser(userId);
  if (!user) return { plan: "trial" };

  let plan = user.plan;

  // trial期限チェック
  if (plan === "trial") {
    const remaining = getTrialDaysRemaining(userId);
    if (remaining <= 0) {
      // 期限切れだが決済未実装のため全機能継続
      // updateUserPlan(userId, "expired"); // 決済実装後に有効化
      return { plan: "trial", trialWarning: "無料体験期間が終了しましたが、決済機能の公開まで引き続き全機能をお使いいただけます。" };
    }
    if (remaining <= 2) {
      return { plan, trialWarning: `無料体験残り${remaining}日です。` };
    }
  }

  return { plan };
}

// ── Main Entry ──

export async function handleWithSecretary(
  userId: string,
  userText: string,
): Promise<string> {
  // Google未連携チェック
  const accounts = getGoogleAccountsByUserId(userId);
  const user = getUser(userId);
  if (accounts.length === 0 && !user?.gmailToken) {
    const authUrl = buildAuthUrl(userId);
    return `Googleアカウントがまだ連携されていません。\n以下のリンクから連携してください👇\n${authUrl}`;
  }

  // プランチェック
  const { plan, trialWarning } = checkPlan(userId);
  console.log(`[secretary] plan=${plan} user=${userId}`);

  // expired → プラン案内（決済未実装のため実際には到達しない）
  if (plan === "expired") {
    return EXPIRED_MESSAGE;
  }

  let result: string;

  try {
    // SimpleCommand\u306F\u5168\u30D7\u30E9\u30F3\u3067\u6700\u521D\u306B\u51E6\u7406\uFF08Sonnet\u4E0D\u4F7F\u7528\u30FB\u7121\u6599\uFF09
    const simpleCmd = matchSimpleCommand(userText);
    if (simpleCmd) {
      result = await execSimpleCommand(simpleCmd, userId);
      addConversation(userId, "user", userText);
      addConversation(userId, "assistant", result);
      if (trialWarning) return result + `\n\n${trialWarning}`;
      return result;
    }

    // \u5168\u30D7\u30E9\u30F3\u3067proAgentLoop\uFF08\u30AF\u30EC\u30B8\u30C3\u30C8\u4E0A\u9650\u306FproAgentLoop\u5185\u3067\u30C1\u30A7\u30C3\u30AF\uFF09
    result = await proAgentLoop(userId, userText, plan);
  } catch (err) {
    console.error(`[secretary] handleWithSecretary error (${userId}):`, err);
    return classifyError(err, userId);
  }

  // trial残日数警告を追記
  if (trialWarning) {
    result += `\n\n${trialWarning}`;
  }

  return result;
}

// ── Pro Agent Loop (Sonnet + Tool Use) ──

async function proAgentLoop(userId: string, userText: string, plan: string): Promise<string> {
  console.log(`[secretary] agentic mode: "${userText}"`);

  if (!process.env["ANTHROPIC_API_KEY"]) {
    addConversation(userId, "user", userText, "agentic_no_key");
    const fallback = "ANTHROPIC_API_KEY\u304C\u672A\u8A2D\u5B9A\u306E\u305F\u3081\u3001\u8907\u96D1\u306A\u30EA\u30AF\u30A8\u30B9\u30C8\u306F\u51E6\u7406\u3067\u304D\u307E\u305B\u3093\u3002.env\u306BAPI\u30AD\u30FC\u3092\u8A2D\u5B9A\u3057\u3066\u304F\u3060\u3055\u3044\u3002";
    addConversation(userId, "assistant", fallback);
    return fallback;
  }

  // 使用量チェック
  const usageCheck = checkUsageLimit(userId, plan, "credit");
  if (!usageCheck.allowed) {
    const resetDate = getResetDate();
    const limit = USAGE_LIMITS[plan]?.["credit"] ?? 0;
    return `\u4ECA\u6708\u306E\u30AF\u30EC\u30B8\u30C3\u30C8\u304C\u4E0A\u9650\uFF08${limit}\uFF09\u306B\u9054\u3057\u307E\u3057\u305F\u3002\n\n\u30EA\u30BB\u30C3\u30C8\u65E5\uFF1A${resetDate}\n\n\u30D7\u30ED\u30D7\u30E9\u30F3\u306B\u30A2\u30C3\u30D7\u30B0\u30EC\u30FC\u30C9\u3059\u308B\u3068300\u30AF\u30EC\u30B8\u30C3\u30C8/\u6708\u3054\u5229\u7528\u3044\u305F\u3060\u3051\u307E\u3059\u3002\n\uFF08\u6C7A\u6E08\u6A5F\u80FD\u306F\u8FD1\u65E5\u516C\u958B\u4E88\u5B9A\u3067\u3059\uFF09`;
  }

  // 会話履歴を取得
  const history = getRecentConversations(userId, 10);
  const messages: MessageParam[] = [
    ...history.map((h) => ({ role: h.role, content: h.content }) as MessageParam),
    { role: "user" as const, content: userText },
  ];

  addConversation(userId, "user", userText, "agentic");

  const client = new Anthropic();
  const MAX_TURNS = 3;

  for (let turn = 0; turn < MAX_TURNS; turn++) {
    const response = await client.messages.create({
      model: "claude-sonnet-4-6",
      max_tokens: 1024,
      system: buildSystemPrompt(userId),
      tools: TOOLS,
      messages,
    });

    // テキストのみの場合 → 完了
    if (response.stop_reason === "end_turn") {
      const textBlock = response.content.find((b) => b.type === "text");
      const reply = textBlock && "text" in textBlock ? textBlock.text : "\u3059\u307F\u307E\u305B\u3093\u3001\u3046\u307E\u304F\u51E6\u7406\u3067\u304D\u307E\u305B\u3093\u3067\u3057\u305F\u3002";
      addConversation(userId, "assistant", reply);
      logUsage(userId, "credit");
      checkAndNotifyUsageAlert(userId, plan, "credit").catch(() => {});
      return reply;
    }

    // tool_use がある場合
    if (response.stop_reason === "tool_use") {
      // assistantメッセージをそのまま追加
      messages.push({ role: "assistant", content: response.content as ContentBlockParam[] });

      // ツール実行結果を集める
      const toolResults: ToolResultBlockParam[] = [];
      for (const block of response.content) {
        if (block.type === "tool_use") {
          const toolUse = block as ToolUseBlock;
          console.log(`[secretary] tool_use: ${toolUse.name}`);
          try {
            const result = await executeTool(toolUse.name, toolUse.input as Record<string, unknown>, userId);
            toolResults.push({
              type: "tool_result",
              tool_use_id: toolUse.id,
              content: result,
            });
          } catch (err) {
            console.error(`[secretary] tool error (${toolUse.name}):`, err);
            // 再認証が必要なエラーは即座にユーザーに返す
            if (err instanceof ReauthRequiredError || err instanceof GoogleApiError) {
              const reply = classifyError(err, userId);
              addConversation(userId, "assistant", reply);
              return reply;
            }
            const friendlyMsg = toolUse.name === "create_calendar_event"
              ? "予定の登録に失敗しました。日時や内容を確認してもう一度お試しください。"
              : "データの取得中にエラーが発生しました。";
            toolResults.push({
              type: "tool_result",
              tool_use_id: toolUse.id,
              content: friendlyMsg,
              is_error: true,
            });
          }
        }
      }

      messages.push({ role: "user", content: toolResults });
      continue;
    }

    // それ以外 → テキスト抽出して返す
    const textBlock = response.content.find((b) => b.type === "text");
    const reply = textBlock && "text" in textBlock ? textBlock.text : "\u51E6\u7406\u304C\u5B8C\u4E86\u3057\u307E\u3057\u305F\u3002";
    addConversation(userId, "assistant", reply);
    logUsage(userId, "credit");
    checkAndNotifyUsageAlert(userId, plan, "credit").catch(() => {});
    return reply;
  }

  const fallback = "\u51E6\u7406\u304C\u8907\u96D1\u3059\u304E\u308B\u305F\u3081\u3001\u3082\u3046\u5C11\u3057\u5177\u4F53\u7684\u306B\u304A\u9858\u3044\u3057\u307E\u3059\u3002";
  addConversation(userId, "assistant", fallback);
  logUsage(userId, "credit");
  checkAndNotifyUsageAlert(userId, plan, "credit").catch(() => {});
  return fallback;
}
