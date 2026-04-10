import Anthropic from "@anthropic-ai/sdk";
import type {
  MessageParam,
  ContentBlockParam,
  ToolResultBlockParam,
  ToolUseBlock,
} from "@anthropic-ai/sdk/resources/messages.js";
import { tools } from "./tools.js";
import { executeTool } from "./executor.js";

const SYSTEM_PROMPT = (userName: string) =>
  `あなたはAI秘書サービスのアシスタントです。
ユーザーのGmailとGoogleカレンダーを管理します。
ユーザー名: ${userName}

返信はLINEで読みやすい簡潔な日本語で。重要な情報は箇条書きで。
メールへの返信提案は必ず本人確認を取ってから送信すること。`;

export async function runAgent(
  userId: string,
  userMessage: string,
  userName: string,
): Promise<string> {
  const client = new Anthropic();

  const messages: MessageParam[] = [
    { role: "user", content: userMessage },
  ];

  // cache_control を最後のツールに付与
  const cachedTools = tools.map((tool, i) =>
    i === tools.length - 1
      ? { ...tool, cache_control: { type: "ephemeral" as const } }
      : tool,
  );

  while (true) {
    const response = await client.messages.create({
      model: "claude-sonnet-4-6",
      max_tokens: 1024,
      system: [
        {
          type: "text",
          text: SYSTEM_PROMPT(userName),
          cache_control: { type: "ephemeral" },
        },
      ],
      tools: cachedTools,
      messages,
    });

    // tool_use でなければ最終応答を返す
    if (response.stop_reason !== "tool_use") {
      const textBlocks = response.content.filter((b) => b.type === "text");
      return textBlocks.map((b) => b.text).join("\n") || "処理が完了しました。";
    }

    // tool_use ブロックを処理
    const toolUseBlocks = response.content.filter(
      (b): b is ToolUseBlock => b.type === "tool_use",
    );

    // assistantの応答をmessagesに追加
    messages.push({ role: "assistant", content: response.content as ContentBlockParam[] });

    // 各ツールを実行してresultを収集
    const toolResults: ToolResultBlockParam[] = [];
    for (const toolUse of toolUseBlocks) {
      let result: string;
      try {
        result = await executeTool(
          toolUse.name,
          toolUse.input as Record<string, unknown>,
          userId,
        );
      } catch (err) {
        result = `エラー: ${err instanceof Error ? err.message : String(err)}`;
      }
      toolResults.push({
        type: "tool_result",
        tool_use_id: toolUse.id,
        content: result,
      });
    }

    messages.push({ role: "user", content: toolResults });
  }
}
