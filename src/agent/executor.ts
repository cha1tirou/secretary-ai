import { getUnreadEmails, getAllEmails, sendReply, getAttachment, getMessageWithAttachments } from "../integrations/gmail.js";
import { getWeekEvents, createEvent } from "../integrations/gcal.js";
import { getDb, createTimer, createEmailWatchRule, getActiveEmailWatchRules, deleteEmailWatchRule } from "../db/queries.js";

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
      const msg = await getMessageWithAttachments(userId, messageId);
      if (!msg) return "指定されたメールが見つかりません。";
      let result = `件名: ${msg.subject}\n送信者: ${msg.from}\n宛先: ${msg.to}\nCC: ${msg.cc}\n日時: ${msg.date}\n\n${msg.body}`;
      if (msg.attachments.length > 0) {
        result += "\n\n--- 添付ファイル ---";
        for (const att of msg.attachments) {
          result += `\nファイル名: ${att.filename}\nMIMEタイプ: ${att.mimeType}\nサイズ: ${Math.round(att.size / 1024)}KB\n添付ID: ${att.attachmentId}`;
        }
        result += "\n\n※ gmail_get_attachment ツールで添付ファイルの内容を解析できます。";
      }
      return result;
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

    case "gmail_get_attachment": {
      const messageId = input["message_id"] as string;
      const attachmentId = input["attachment_id"] as string;
      const filename = input["filename"] as string;
      const mimeType = input["mime_type"] as string;

      const attachmentData = await getAttachment(userId, messageId, attachmentId);
      if (!attachmentData) {
        return "添付ファイルの取得に失敗しました。";
      }

      const buffer = Buffer.from(attachmentData, "base64url");
      const base64 = buffer.toString("base64");

      const Anthropic = (await import("@anthropic-ai/sdk")).default;
      const anthropic = new Anthropic();

      if (mimeType.startsWith("image/")) {
        const response = await anthropic.messages.create({
          model: "claude-sonnet-4-6",
          max_tokens: 1024,
          messages: [{
            role: "user",
            content: [
              {
                type: "image",
                source: {
                  type: "base64",
                  media_type: mimeType as "image/jpeg" | "image/png" | "image/gif" | "image/webp",
                  data: base64,
                },
              },
              {
                type: "text",
                text: "この添付ファイルの内容を日本語で要約してください。契約書・請求書・見積書などのビジネス文書であれば、金額・日付・担当者・重要な条件などを箇条書きで抽出してください。",
              },
            ],
          }],
        });
        const block = response.content[0];
        return block && block.type === "text" ? block.text : "解析できませんでした。";
      } else if (mimeType === "application/pdf") {
        try {
          const { PDFParse } = await import("pdf-parse");
          const parser = new PDFParse({ data: buffer });
          const pdfData = await parser.getText();
          const text = pdfData.text.slice(0, 8000);

          const response = await anthropic.messages.create({
            model: "claude-sonnet-4-6",
            max_tokens: 1024,
            messages: [{
              role: "user",
              content: `以下のPDF（${filename}）の内容を日本語で要約してください。ビジネス文書であれば重要な情報（金額・日付・条件など）を箇条書きで抽出してください。\n\n${text}`,
            }],
          });
          const block = response.content[0];
          return block && block.type === "text" ? block.text : "解析できませんでした。";
        } catch {
          return "PDFの解析に失敗しました。画像形式で共有していただくと解析できる場合があります。";
        }
      } else {
        return `${filename} は現在対応していない形式です（${mimeType}）。PDF または画像ファイルに対応しています。`;
      }
    }

    case "set_timer": {
      const minutes = input["minutes"] as number;
      const message = input["message"] as string;

      if (minutes < 1 || minutes > 10080) {
        return "タイマーは1分〜7日の範囲で設定できます。";
      }

      const fireAt = new Date(Date.now() + minutes * 60 * 1000).toISOString();
      createTimer(userId, fireAt, message);

      const display = minutes >= 60
        ? `${Math.floor(minutes / 60)}時間${minutes % 60 > 0 ? (minutes % 60) + "分" : ""}`
        : `${minutes}分`;

      return `⏰ ${display}後にお知らせします！\n「${message}」`;
    }

    case "email_watch_create": {
      const matchType = input["match_type"] as "from" | "subject" | "keyword";
      const pattern = input["pattern"] as string;
      const description = input["description"] as string;
      const id = createEmailWatchRule(userId, matchType, pattern, description);
      return `メール監視ルールを作成しました（ID: ${id}）\n条件: ${description}\n新着メールが条件に合致したらLINEでお知らせします。`;
    }

    case "email_watch_list": {
      const rules = getActiveEmailWatchRules(userId);
      if (rules.length === 0) return "現在有効なメール監視ルールはありません。";
      return rules
        .map((r) => `ID: ${r.id} | ${r.description}\n  タイプ: ${r.matchType} | パターン: ${r.pattern}`)
        .join("\n---\n");
    }

    case "email_watch_delete": {
      const ruleId = input["rule_id"] as number;
      const deleted = deleteEmailWatchRule(userId, ruleId);
      return deleted
        ? `ルール（ID: ${ruleId}）を削除しました。`
        : `ルール（ID: ${ruleId}）が見つかりません。`;
    }

    default:
      return `不明なツール: ${toolName}`;
  }
}
