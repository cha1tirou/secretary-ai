import { messagingApi } from "@line/bot-sdk";
import {
  updateDisplayName,
  updateBriefingHour,
  updateSetupStage,
  updateUseCases,
  getUser,
} from "../db/queries.js";

type Client = messagingApi.MessagingApiClient;

/** セットアップ段階 */
export type SetupStage = "name" | "briefing" | "usecases";

/** セットアップ開始（OAuth連携完了直後に呼ぶ） */
export async function startSetup(client: Client, userId: string, email: string | null): Promise<void> {
  updateSetupStage(userId, "name");
  const accountInfo = email ? `（${email}）` : "";
  await client.pushMessage({
    to: userId,
    messages: [
      {
        type: "text",
        text: `✅ Googleアカウントの連携が完了しました${accountInfo}\n\n簡単なセットアップを行います（30秒くらい）。\n\nまず、なんてお呼びすればいいですか？\n\n例：田中、たなさん、太郎 など`,
      },
    ],
  });
}

/** ブリーフィング時刻の Quick Reply */
function briefingQuickReply(): messagingApi.Message {
  return {
    type: "text",
    text: "ありがとうございます！\n\n次に、朝のブリーフィング（その日の要対応メールと予定のまとめ）は何時にお届けしますか？",
    quickReply: {
      items: [
        { type: "action", action: { type: "message", label: "7時", text: "ブリーフィング:7時" } },
        { type: "action", action: { type: "message", label: "8時", text: "ブリーフィング:8時" } },
        { type: "action", action: { type: "message", label: "9時", text: "ブリーフィング:9時" } },
        { type: "action", action: { type: "message", label: "不要", text: "ブリーフィング:不要" } },
      ],
    },
  };
}

/** 使い方の Quick Reply */
function useCasesQuickReply(): messagingApi.Message {
  return {
    type: "text",
    text: "最後に、どんな使い方を一番重視しますか？",
    quickReply: {
      items: [
        { type: "action", action: { type: "message", label: "メール管理", text: "使い方:メール管理" } },
        { type: "action", action: { type: "message", label: "日程調整", text: "使い方:日程調整" } },
        { type: "action", action: { type: "message", label: "リマインダー", text: "使い方:リマインダー" } },
        { type: "action", action: { type: "message", label: "全部使いたい", text: "使い方:全部" } },
      ],
    },
  };
}

/** 完了メッセージ（パーソナライズあり） */
function buildCompletionMessage(name: string, briefingHour: number, trialStartDate: string | null): string {
  const briefingLine = briefingHour === 0
    ? "朝のブリーフィングは送りません（「設定」でいつでも変更できます）。"
    : `毎朝 ${briefingHour}:00 に今日のブリーフィングをお届けします。`;

  const trialEnd = trialStartDate
    ? new Date(new Date(trialStartDate).getTime() + 7 * 24 * 3600 * 1000)
    : new Date(Date.now() + 7 * 24 * 3600 * 1000);
  const trialEndLabel = trialEnd.toLocaleDateString("ja-JP", { year: "numeric", month: "2-digit", day: "2-digit" });

  return [
    `🎉 セットアップ完了です、${name}さん！`,
    "",
    `🎁 ${trialEndLabel} まで Proプランを無料でお試しいただけます（月150通まで送信OK）`,
    "",
    briefingLine,
    "",
    "━━ こんなふうに使えます ━━",
    "",
    "📨 メール確認",
    "「未読メールある？」",
    "「田中さんからのメール見せて」",
    "",
    "✍️ 返信",
    "「承諾で返信して」",
    "「丁寧にお断りの文案つくって」",
    "",
    "📅 日程調整",
    "「来週の予定は？」",
    "「金曜15時に打合せ入れて」",
    "",
    "⏰ リマインダー",
    "「30分後に電話するってリマインドして」",
    "",
    "━━━━━━━━━━━━━━",
    "設定を変えたいときは「設定」と送ってください🙌",
    "プランの詳細は「プラン」、今月の使用量は「使用量」でチェックできます。",
  ].join("\n");
}

/** セットアップ中のメッセージかどうか判定し、該当すれば処理して true を返す */
export async function handleSetupMessage(
  client: Client,
  userId: string,
  text: string,
  replyToken: string,
): Promise<boolean> {
  const user = getUser(userId);
  if (!user) return false;

  // 「設定」キーワードでセットアップを再開
  const trimmed = text.trim();
  if (trimmed === "設定") {
    updateSetupStage(userId, "name");
    await client.replyMessage({
      replyToken,
      messages: [
        {
          type: "text",
          text: "設定を変更します。\n\nなんてお呼びすればいいですか？\n\n例：田中、たなさん、太郎 など",
        },
      ],
    });
    return true;
  }

  const stage = user.setupStage;
  if (!stage) return false;

  // Stage 1: 呼び名
  if (stage === "name") {
    const name = trimmed.slice(0, 30); // 過度に長い入力を切る
    if (!name) {
      await client.replyMessage({
        replyToken,
        messages: [{ type: "text", text: "お名前を教えてください🙏" }],
      });
      return true;
    }
    updateDisplayName(userId, name);
    updateSetupStage(userId, "briefing");
    await client.replyMessage({
      replyToken,
      messages: [briefingQuickReply()],
    });
    return true;
  }

  // Stage 2: ブリーフィング時刻
  if (stage === "briefing") {
    const match = trimmed.match(/^ブリーフィング:(.+)$/);
    const value = match ? match[1] : trimmed;
    let hour: number | null = null;
    if (value === "7時" || value === "7") hour = 7;
    else if (value === "8時" || value === "8") hour = 8;
    else if (value === "9時" || value === "9") hour = 9;
    else if (value === "不要" || value === "いらない" || value === "無し" || value === "なし") hour = 0;

    if (hour === null) {
      await client.replyMessage({
        replyToken,
        messages: [briefingQuickReply()],
      });
      return true;
    }
    updateBriefingHour(userId, hour);
    updateSetupStage(userId, "usecases");
    await client.replyMessage({
      replyToken,
      messages: [useCasesQuickReply()],
    });
    return true;
  }

  // Stage 3: 使い方
  if (stage === "usecases") {
    const match = trimmed.match(/^使い方:(.+)$/);
    const value = (match ? match[1] : trimmed) ?? "";
    const allowed = ["メール管理", "日程調整", "リマインダー", "全部"];
    const chosen = allowed.find((a) => value.includes(a));
    if (!chosen) {
      await client.replyMessage({
        replyToken,
        messages: [useCasesQuickReply()],
      });
      return true;
    }
    updateUseCases(userId, chosen);
    updateSetupStage(userId, null);

    const updated = getUser(userId);
    const name = updated?.displayName ?? "あなた";
    const briefingHour = updated?.briefingHour ?? 8;
    const trialStartDate = updated?.trialStartDate ?? null;
    await client.replyMessage({
      replyToken,
      messages: [{ type: "text", text: buildCompletionMessage(name, briefingHour, trialStartDate) }],
    });
    return true;
  }

  return false;
}
