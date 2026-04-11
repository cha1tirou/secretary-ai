import type { Tool } from "@anthropic-ai/sdk/resources/messages.js";

export const tools: Tool[] = [
  {
    name: "gmail_list_unread",
    description: "未読メールの一覧を取得します。件名・送信者・日時・IDを返します。",
    input_schema: {
      type: "object" as const,
      properties: {},
      required: [],
    },
  },
  {
    name: "gmail_get_message",
    description: "指定IDのメール本文を取得します。",
    input_schema: {
      type: "object" as const,
      properties: {
        message_id: {
          type: "string",
          description: "メールのID",
        },
      },
      required: ["message_id"],
    },
  },
  {
    name: "gmail_send",
    description: "メールを送信します。必ずユーザーの確認を取ってから使用してください。",
    input_schema: {
      type: "object" as const,
      properties: {
        to: {
          type: "string",
          description: "送信先メールアドレス",
        },
        subject: {
          type: "string",
          description: "件名",
        },
        body: {
          type: "string",
          description: "本文",
        },
      },
      required: ["to", "subject", "body"],
    },
  },
  {
    name: "calendar_get_events",
    description: "今日から7日間のカレンダー予定を取得します。",
    input_schema: {
      type: "object" as const,
      properties: {},
      required: [],
    },
  },
  {
    name: "calendar_create_event",
    description: "カレンダーに予定を作成します。",
    input_schema: {
      type: "object" as const,
      properties: {
        title: {
          type: "string",
          description: "予定のタイトル",
        },
        start: {
          type: "string",
          description: "開始日時（ISO 8601形式、例: 2024-01-15T10:00:00+09:00）",
        },
        end: {
          type: "string",
          description: "終了日時（ISO 8601形式、例: 2024-01-15T11:00:00+09:00）",
        },
        location: {
          type: "string",
          description: "場所（任意）",
        },
        description: {
          type: "string",
          description: "説明（任意）",
        },
      },
      required: ["title", "start", "end"],
    },
  },
  {
    name: "gmail_get_attachment",
    description: "メールの添付ファイルを取得して内容を解析します。PDFや画像ファイルに対応。gmail_get_messageで添付ファイルのIDを確認してから使ってください。",
    input_schema: {
      type: "object" as const,
      properties: {
        message_id: {
          type: "string",
          description: "メールのID",
        },
        attachment_id: {
          type: "string",
          description: "添付ファイルのID",
        },
        filename: {
          type: "string",
          description: "添付ファイルのファイル名",
        },
        mime_type: {
          type: "string",
          description: "添付ファイルのMIMEタイプ（例: application/pdf, image/jpeg）",
        },
      },
      required: ["message_id", "attachment_id", "filename", "mime_type"],
    },
  },
  {
    name: "set_timer",
    description: "タイマーをセットします。指定した分数後にLINEでリマインド通知を送ります。",
    input_schema: {
      type: "object" as const,
      properties: {
        minutes: {
          type: "number",
          description: "何分後にリマインドするか（1〜10080分 = 最大7日）",
        },
        message: {
          type: "string",
          description: "リマインド時に表示するメッセージ",
        },
      },
      required: ["minutes", "message"],
    },
  },
  {
    name: "memory_get",
    description: "ユーザーが保存したメモを取得します。",
    input_schema: {
      type: "object" as const,
      properties: {
        key: {
          type: "string",
          description: "メモのキー",
        },
      },
      required: ["key"],
    },
  },
  {
    name: "memory_set",
    description: "ユーザーのメモを保存します。",
    input_schema: {
      type: "object" as const,
      properties: {
        key: {
          type: "string",
          description: "メモのキー",
        },
        value: {
          type: "string",
          description: "メモの値",
        },
      },
      required: ["key", "value"],
    },
  },
  {
    name: "email_watch_create",
    description: "メール監視ルールを作成します。条件に合致するメールが届いたらLINEで通知します。",
    input_schema: {
      type: "object" as const,
      properties: {
        match_type: {
          type: "string",
          enum: ["from", "subject", "keyword"],
          description: "マッチ対象: from=送信者, subject=件名, keyword=全体（送信者・件名・本文）",
        },
        pattern: {
          type: "string",
          description: "マッチする文字列（部分一致、例: tanaka, 田中, 請求書）",
        },
        description: {
          type: "string",
          description: "ルールの説明（例: 田中さんからのメール）",
        },
      },
      required: ["match_type", "pattern", "description"],
    },
  },
  {
    name: "email_watch_list",
    description: "現在有効なメール監視ルールの一覧を表示します。",
    input_schema: {
      type: "object" as const,
      properties: {},
      required: [],
    },
  },
  {
    name: "email_watch_delete",
    description: "メール監視ルールを削除します。",
    input_schema: {
      type: "object" as const,
      properties: {
        rule_id: {
          type: "number",
          description: "削除するルールのID（email_watch_listで確認）",
        },
      },
      required: ["rule_id"],
    },
  },
];
