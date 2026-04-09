import { getUnreadEmails, getAllEmails, sendReply } from "../integrations/gmail.js";
import { getWeekEvents, createEvent } from "../integrations/gcal.js";
import { getDb } from "../db/queries.js";

function ensureMemoryTable(): void {
  getDb().exec(`
    CREATE TABLE IF NOT EXISTS keyvalue (
      user_id TEXT NOT NULL,
      key TEXT NOT NULL,
      value TEXT NOT NULL,
      updated_at TEXT DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (user_id, key)
    )
  `);
}

let memoryTableReady = false;

function initMemoryTable(): void {
  if (!memoryTableReady) {
    ensureMemoryTable();
    memoryTableReady = true;
  }
}

export async function executeTool(
  toolName: string,
  input: Record<string, unknown>,
  userId: string,
): Promise<string> {
  switch (toolName) {
    case "gmail_list_unread": {
      const emails = await getUnreadEmails(userId);
      if (emails.length === 0) return "未読メールはありません。";
      return emails
        .map((e) => `ID: ${e.id}\n件名: ${e.subject}\n送信者: ${e.from}\n日時: ${e.date}`)
        .join("\n---\n");
    }

    case "gmail_get_message": {
      const messageId = input["message_id"] as string;
      const emails = await getAllEmails(userId, 50);
      const email = emails.find((e) => e.id === messageId);
      if (!email) return "指定されたメールが見つかりません。";
      return `件名: ${email.subject}\n送信者: ${email.from}\n宛先: ${email.to}\nCC: ${email.cc}\n日時: ${email.date}\n\n${email.body}`;
    }

    case "gmail_send": {
      const to = input["to"] as string;
      const subject = input["subject"] as string;
      const body = input["body"] as string;
      // sendReply requires a threadId; for new emails we pass empty string
      const result = await sendReply(userId, "", to, subject, body);
      return `メールを送信しました。(ID: ${result})`;
    }

    case "calendar_get_events": {
      const events = await getWeekEvents(userId);
      if (events.length === 0) return "今後7日間に予定はありません。";
      return events
        .map((e) => `${e.start} - ${e.end}\n${e.summary}${e.location ? `\n場所: ${e.location}` : ""}`)
        .join("\n---\n");
    }

    case "calendar_create_event": {
      const params: { title: string; start: string; end: string; location?: string; description?: string } = {
        title: input["title"] as string,
        start: input["start"] as string,
        end: input["end"] as string,
      };
      if (input["location"]) params.location = input["location"] as string;
      if (input["description"]) params.description = input["description"] as string;
      const event = await createEvent(userId, params);
      return `予定を作成しました: ${event.summary}（${event.start} - ${event.end}）`;
    }

    case "memory_get": {
      initMemoryTable();
      const key = input["key"] as string;
      const row = getDb()
        .prepare("SELECT value FROM keyvalue WHERE user_id = ? AND key = ?")
        .get(userId, key) as { value: string } | undefined;
      return row ? row.value : `「${key}」のメモは見つかりません。`;
    }

    case "memory_set": {
      initMemoryTable();
      const key = input["key"] as string;
      const value = input["value"] as string;
      getDb()
        .prepare(
          `INSERT INTO keyvalue (user_id, key, value, updated_at)
           VALUES (?, ?, ?, CURRENT_TIMESTAMP)
           ON CONFLICT(user_id, key) DO UPDATE SET
             value = excluded.value,
             updated_at = CURRENT_TIMESTAMP`,
        )
        .run(userId, key, value);
      return `「${key}」を保存しました。`;
    }

    default:
      return `不明なツール: ${toolName}`;
  }
}
