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
];
