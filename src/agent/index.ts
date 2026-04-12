import Anthropic from "@anthropic-ai/sdk";
import type {
  MessageParam,
  ContentBlockParam,
  ToolResultBlockParam,
  ToolUseBlock,
  ImageBlockParam,
  TextBlockParam,
} from "@anthropic-ai/sdk/resources/messages.js";
import { tools } from "./tools.js";
import { executeTool } from "./executor.js";
import { getBriefingItem, addConversation, getRecentConversations } from "../db/queries.js";

export type Attachment = {
  type: "image";
  mediaType: "image/jpeg" | "image/png" | "image/gif" | "image/webp";
  base64: string;
} | {
  type: "document";
  mediaType: "application/pdf";
  base64: string;
  fileName: string;
};

const SYSTEM_PROMPT = (userName: string) =>
  `あなたはAI秘書サービスのアシスタントです。
ユーザー名: ${userName}

## あなたの役割
GmailとGoogleカレンダーを使って、以下の業務を行います：
1. メールの要約・優先度判断（重要なものだけ報告）
2. 返信文案の生成（必ず送信前にユーザーに確認する）
3. 日程調整（カレンダーを確認して候補を提案、ユーザー確認後に返信）

## 絶対ルール
- メール送信は必ずユーザーの「OK」「送って」など明示的な許可を得てから
- 返信文案は簡潔・丁寧な日本語で
- LINEで読みやすいよう短くまとめる（箇条書き活用）
- 優先度が高いメールは明確に「⚠️ 要対応」と表示

## 複合タスクの処理方針
- ユーザーが複数の操作を一度に依頼した場合（例:「メール全部探して要約して返信案も出して」）、できる範囲で全て実行してから報告する。情報確認だけで止まらない
- ただし複合タスクは処理を段階的に分けて、まず最初のステップだけ実行してユーザーに報告し、続きは次のターンで行う（LINEは3秒応答制約があるため、長時間のツール直列実行は避ける）
- 例:「メール検索→要約→返信案」なら、まず検索+要約結果を返し、「返信案作る?」と次の行動を促す

## 添付ファイル読み取り
- メッセージに画像やPDFのデータが直接含まれている場合があります（LINEから送られたファイル）。
  その場合はデータがそのまま見えているので、内容を読み取って回答してください。
- ユーザーが「添付ファイル」「添付を読んで」「PDFを教えて」などと言い、
  メッセージに添付データが含まれていない場合は、
  gmail_get_messageで該当メールを取得し、添付ファイルのIDとMIMEタイプを確認してから
  gmail_get_attachmentで解析する
- 対応形式: PDF、画像（JPEG/PNG等）

## メール監視
- 「〇〇からメールが来たら教えて」「請求書のメールが届いたら通知して」→ email_watch_create を使う
- match_type の選び方（重要: 最適なタイプを選ぶこと）:
  - "from_and_keyword": 「〇〇からの△△」のように送信者+内容が両方指定された場合。pattern=送信者名、pattern2=キーワード。最も精度が高いので積極的に使う
  - "from": 送信者だけ指定された場合（「〇〇からメール来たら」）
  - "subject": 件名だけ指定された場合
  - "keyword": 送信者も件名も不明で広く探したい場合（誤マッチが多いので慎重に）
- pattern にはメールアドレス・名前・キーワードを設定（部分一致）
- 「監視ルール一覧」→ email_watch_list、「監視やめて」→ email_watch_delete

## タイマー
- 「〇分後にリマインドして」「〇時間後に教えて」などはset_timerツールを使う
- 「田中さんへの返信を30分後に思い出させて」→ message は「田中さんへの返信」にする
- 絶対時刻（「明日の9時に」）の場合は現在時刻から分数を計算して設定する`;

function parseCircledNumber(s: string): number {
  const circled = "①②③④⑤⑥⑦⑧⑨⑩⑪⑫⑬⑭⑮⑯⑰⑱⑲⑳";
  const idx = circled.indexOf(s);
  if (idx >= 0) return idx + 1;
  return parseInt(s, 10);
}

export async function runAgent(
  userId: string,
  userMessage: string,
  userName: string,
  attachments?: Attachment[],
): Promise<string> {
  // 数字入力の検知（1〜20、①〜⑳）
  const numMatch = userMessage
    .trim()
    .match(/^([①②③④⑤⑥⑦⑧⑨⑩⑪⑫⑬⑭⑮⑯⑰⑱⑲⑳]|1[0-9]?|20|[2-9])$/);
  if (numMatch) {
    const num = parseCircledNumber(numMatch[1]!);
    const item = getBriefingItem(userId, num);

    if (!item) {
      return `${num}番のアイテムが見つかりません。\n最新のブリーフィングで表示された番号を入力してください。`;
    }

    const detailPrompt = `ユーザーが番号 ${num} を選択しました。
対象メール: ${item.summary}
メールID: ${item.emailId}

このメールの内容をgmail_get_messageで取得して、
内容を理解した上で以下を実施してください：

1. メールの内容を2-3行で要約
2. このメールに対して取りうる行動を a) b) c) の形式で提案
   ※ メール内容に応じて動的に提案すること
   （例：日程調整メールなら「a) カレンダーを確認して候補を返信」
         見積もり確認なら「a) 承諾 b) 修正依頼 c) 検討中と伝える」
         質問メールなら「a) ○○と回答する b) 確認してから返信する」）

LINEで読みやすく、簡潔に。`;

    return await runAgentLoop(userId, detailPrompt, userName);
  }

  // 通常のAgentループ
  return await runAgentLoop(userId, userMessage, userName, attachments);
}

/** ブリーフィング用: JSON応答を期待する場合に使う */
export async function runAgentRaw(
  userId: string,
  userMessage: string,
  userName: string,
): Promise<string> {
  return await runAgentLoop(userId, userMessage, userName);
}

async function runAgentLoop(
  userId: string,
  userMessage: string,
  userName: string,
  attachments?: Attachment[],
): Promise<string> {
  const client = new Anthropic();

  // 添付ファイルがある場合はマルチコンテンツブロックで送信
  let userContent: string | (TextBlockParam | ImageBlockParam)[];
  if (attachments && attachments.length > 0) {
    console.log(`[agent] attachments: ${attachments.length} items (${attachments.map(a => a.type).join(", ")})`);
    const blocks: (TextBlockParam | ImageBlockParam)[] = [];
    for (const att of attachments) {
      if (att.type === "image") {
        blocks.push({
          type: "image",
          source: { type: "base64", media_type: att.mediaType, data: att.base64 },
        });
      } else if (att.type === "document") {
        // PDFはpdf-parseでテキスト抽出してからテキストブロックとして送信
        try {
          const { PDFParse } = await import("pdf-parse");
          const buffer = Buffer.from(att.base64, "base64");
          const parser = new PDFParse({ data: buffer });
          const pdfData = await parser.getText();
          const pdfText = pdfData.text.slice(0, 8000);
          console.log(`[agent] PDF parsed: ${pdfText.length} chars from ${att.fileName}`);
          blocks.push({
            type: "text",
            text: `【添付PDF: ${att.fileName}】\n${pdfText}`,
          });
        } catch (err) {
          console.error("[agent] PDF parse error:", err);
          blocks.push({
            type: "text",
            text: `【添付PDF: ${att.fileName}】PDFのテキスト抽出に失敗しました。`,
          });
        }
      }
    }
    blocks.push({ type: "text", text: userMessage });
    userContent = blocks;
  } else {
    userContent = userMessage;
  }

  // 会話履歴を取得してコンテキストに含める
  const history = getRecentConversations(userId, 10);
  const messages: MessageParam[] = [
    ...history.map((h) => ({ role: h.role, content: h.content }) as MessageParam),
    { role: "user", content: userContent },
  ];

  addConversation(userId, "user", userMessage);

  // cache_control を最後のツールに付与
  const cachedTools = tools.map((tool, i) =>
    i === tools.length - 1
      ? { ...tool, cache_control: { type: "ephemeral" as const } }
      : tool,
  );

  while (true) {
    const response = await client.messages.create({
      model: "claude-sonnet-4-6",
      max_tokens: 2048,
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
      const reply = textBlocks.map((b) => b.text).join("\n") || "処理が完了しました。";
      addConversation(userId, "assistant", reply);
      return reply;
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
