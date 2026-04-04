import Anthropic from "@anthropic-ai/sdk";

const isDev = process.env["NODE_ENV"] === "development";

export type ParsedEvent = {
  title: string;
  date: string;      // YYYY-MM-DD
  startTime: string;  // HH:mm
  endTime: string;    // HH:mm
  location?: string;
};

const SYSTEM_PROMPT = `ユーザーの予定登録リクエストから以下の情報をJSON形式で抽出してください。
今日の日付は ${new Date().toISOString().split("T")[0] ?? ""} です。

{"title": "予定名", "date": "YYYY-MM-DD", "startTime": "HH:mm", "endTime": "HH:mm", "location": "場所（あれば）"}

ルール:
- 「明日」「来週月曜」などは具体的な日付に変換
- 終了時刻が不明なら開始の1時間後
- 時刻が不明なら "unknown" を返す
- 日付が不明なら "unknown" を返す`;

function parseSimple(text: string): ParsedEvent | null {
  const title = text.replace(/予定|登録|追加|入れて|作って|セット|を|に|の|、|。/g, "").trim();

  // 「明日 14時 ミーティング」のようなパターン
  const timeMatch = text.match(/(\d{1,2})[時:：](\d{0,2})/);
  let startTime = "unknown";
  let endTime = "unknown";
  if (timeMatch) {
    const h = (timeMatch[1] ?? "0").padStart(2, "0");
    const m = (timeMatch[2] || "00").padStart(2, "0");
    startTime = `${h}:${m}`;
    endTime = `${String(Number(h) + 1).padStart(2, "0")}:${m}`;
  }

  const today = new Date();
  let date: string;
  if (/明日/.test(text)) {
    const d = new Date(today.getTime() + 86400000);
    date = d.toISOString().split("T")[0]!;
  } else if (/明後日|あさって/.test(text)) {
    const d = new Date(today.getTime() + 2 * 86400000);
    date = d.toISOString().split("T")[0]!;
  } else if (/今日/.test(text)) {
    date = today.toISOString().split("T")[0]!;
  } else {
    const dateMatch = text.match(/(\d{1,2})月(\d{1,2})日/);
    if (dateMatch) {
      const m = dateMatch[1]!.padStart(2, "0");
      const d = dateMatch[2]!.padStart(2, "0");
      date = `${today.getFullYear()}-${m}-${d}`;
    } else {
      date = "unknown";
    }
  }

  if (!title) return null;
  return { title: title || "予定", date, startTime, endTime };
}

export async function parseCalendarRequest(text: string): Promise<ParsedEvent | null> {
  if (isDev) {
    console.log("[DEV] カレンダーパース: 簡易モード");
    return parseSimple(text);
  }

  try {
    const client = new Anthropic();
    const message = await client.messages.create({
      model: "claude-haiku-4-5-20251001",
      max_tokens: 256,
      system: SYSTEM_PROMPT,
      messages: [{ role: "user", content: text }],
    });

    const block = message.content[0];
    if (!block || block.type !== "text") return parseSimple(text);

    return JSON.parse(block.text) as ParsedEvent;
  } catch (err) {
    console.error("[calendar-parser] LLMパースエラー、簡易モードにフォールバック:", err);
    return parseSimple(text);
  }
}
