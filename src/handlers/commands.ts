import { messagingApi } from "@line/bot-sdk";
import {
  getUser,
  getGoogleAccountsByUserId,
  updateStripeIds,
  updateUserPlanAndExpiry,
  getPromoCodeByCode,
  redeemPromoCode,
  getMonthlySendCount,
  getPlanLimit,
  PLAN_PRICES_JPY,
} from "../db/queries.js";
import {
  isStripeEnabled,
  ensureStripeCustomer,
  createCheckoutSession,
  createPortalSession,
  listRecentInvoices,
} from "../integrations/stripe.js";

type Client = messagingApi.MessagingApiClient;

const PLAN_META: Record<"lite" | "standard" | "pro", { label: string; limit: number }> = {
  lite: { label: "Lite", limit: 30 },
  standard: { label: "Standard", limit: 60 },
  pro: { label: "Pro", limit: 150 },
};

function planCarousel(): messagingApi.Message {
  const bubble = (
    plan: "lite" | "standard" | "pro",
    highlight: boolean,
  ): messagingApi.FlexBubble => {
    const meta = PLAN_META[plan];
    const price = PLAN_PRICES_JPY[plan] ?? 0;
    return {
      type: "bubble",
      size: "mega",
      body: {
        type: "box",
        layout: "vertical",
        spacing: "sm",
        contents: [
          { type: "text", text: meta.label, weight: "bold", size: "xxl", color: highlight ? "#22c55e" : "#111827" },
          { type: "text", text: `¥${price.toLocaleString()}/月`, size: "xl", weight: "bold" },
          { type: "text", text: `月${meta.limit}通まで送信`, size: "sm", color: "#64748b", margin: "md" },
        ],
      },
      footer: {
        type: "box",
        layout: "vertical",
        contents: [
          {
            type: "button",
            style: "primary",
            color: highlight ? "#22c55e" : "#111827",
            action: { type: "message", label: "このプランにする", text: `プラン選択:${meta.label}` },
          },
        ],
      },
      ...(highlight ? { styles: { footer: { separator: false } } } : {}),
    };
  };
  return {
    type: "flex",
    altText: "プラン選択",
    contents: {
      type: "carousel",
      contents: [bubble("lite", false), bubble("standard", true), bubble("pro", false)],
    },
  };
}

/** 「プラン」→ プラン選択カルーセル */
async function handlePlanList(client: Client, replyToken: string): Promise<void> {
  await client.replyMessage({
    replyToken,
    messages: [
      { type: "text", text: "プランをお選びください👇" },
      planCarousel(),
    ],
  });
}

/** 「プラン選択:Lite」 等 → Checkout URL */
async function handlePlanSelect(
  client: Client,
  userId: string,
  planLabel: string,
  replyToken: string,
): Promise<void> {
  const planLower = planLabel.toLowerCase() as "lite" | "standard" | "pro";
  if (!["lite", "standard", "pro"].includes(planLower)) {
    await client.replyMessage({
      replyToken,
      messages: [{ type: "text", text: "プランが認識できませんでした。もう一度「プラン」と送ってください。" }],
    });
    return;
  }
  if (!isStripeEnabled()) {
    await client.replyMessage({
      replyToken,
      messages: [{ type: "text", text: "決済機能は準備中です。もうしばらくお待ちください🙏" }],
    });
    return;
  }
  try {
    const user = getUser(userId);
    const accounts = getGoogleAccountsByUserId(userId);
    const email = accounts[0]?.email ?? null;
    const existingCustomerId = user?.stripeCustomerId ?? null;
    const customerId = await ensureStripeCustomer({
      userId,
      email,
      existingCustomerId,
    });
    if (!existingCustomerId) {
      updateStripeIds(userId, customerId, null);
    }
    const url = await createCheckoutSession({ userId, customerId, plan: planLower });
    await client.replyMessage({
      replyToken,
      messages: [
        {
          type: "text",
          text: `${PLAN_META[planLower].label}プランの決済ページです👇\n\n${url}\n\n決済完了後、自動で反映されます。`,
        },
      ],
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error("[commands] checkout error:", err);
    await client.replyMessage({
      replyToken,
      messages: [{ type: "text", text: `決済ページの作成に失敗しました。\n${msg}` }],
    });
  }
}

/** 「解約」→ Customer Portal URL */
async function handleCancel(client: Client, userId: string, replyToken: string): Promise<void> {
  if (!isStripeEnabled()) {
    await client.replyMessage({
      replyToken,
      messages: [{ type: "text", text: "決済機能は準備中です。" }],
    });
    return;
  }
  const user = getUser(userId);
  if (!user?.stripeCustomerId) {
    await client.replyMessage({
      replyToken,
      messages: [{
        type: "text",
        text: "有料プランへの加入が確認できません。\nプロモコード適用中の場合は自動で期限終了します。",
      }],
    });
    return;
  }
  try {
    const url = await createPortalSession(user.stripeCustomerId);
    await client.replyMessage({
      replyToken,
      messages: [{
        type: "text",
        text: `解約・プラン変更はこちらから👇\n\n${url}\n\n解約手続き後、次回更新日までは現プランをご利用いただけます。`,
      }],
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error("[commands] portal error:", err);
    await client.replyMessage({
      replyToken,
      messages: [{ type: "text", text: `ポータル作成に失敗しました。\n${msg}` }],
    });
  }
}

/** 「プロモ XXXX」→ コード適用 */
async function handlePromo(
  client: Client,
  userId: string,
  code: string,
  replyToken: string,
): Promise<void> {
  const trimmed = code.trim().toUpperCase();
  if (!trimmed) {
    await client.replyMessage({
      replyToken,
      messages: [{ type: "text", text: "使い方: 「プロモ XXXXXX」の形式で送ってください" }],
    });
    return;
  }
  const promo = getPromoCodeByCode(trimmed);
  const now = new Date();
  let failReason: string | null = null;
  if (!promo) failReason = "コードが見つかりません";
  else if (!promo.active) failReason = "このコードは停止されています";
  else if (promo.expiresAt && new Date(promo.expiresAt) < now) failReason = "このコードは有効期限切れです";
  else if (promo.maxUses !== null && promo.usedCount >= promo.maxUses) failReason = "このコードは利用上限に達しています";

  if (failReason || !promo) {
    await client.replyMessage({
      replyToken,
      messages: [{ type: "text", text: `❌ ${failReason ?? "無効なコードです"}` }],
    });
    return;
  }

  const expiresAt = new Date();
  expiresAt.setMonth(expiresAt.getMonth() + promo.durationMonths);
  const expiresAtIso = expiresAt.toISOString();

  redeemPromoCode({ userId, codeId: promo.id, plan: promo.plan, expiresAt: expiresAtIso });
  updateUserPlanAndExpiry(userId, promo.plan, expiresAtIso);

  const endLabel = expiresAt.toLocaleDateString("ja-JP", { year: "numeric", month: "2-digit", day: "2-digit" });
  const planLabel = promo.plan.charAt(0).toUpperCase() + promo.plan.slice(1);
  const limit = getPlanLimit(promo.plan);
  await client.replyMessage({
    replyToken,
    messages: [{
      type: "text",
      text: [
        "🎁 プロモコードを適用しました",
        "",
        `・付与プラン: ${planLabel}`,
        `・有効期間: ${promo.durationMonths}ヶ月（${endLabel}まで）`,
        `・月${limit}通まで送信OK`,
        "",
        "試してみてください！",
      ].join("\n"),
    }],
  });
}

/** 「領収書」→ 直近の請求書PDFリスト */
async function handleReceipts(client: Client, userId: string, replyToken: string): Promise<void> {
  if (!isStripeEnabled()) {
    await client.replyMessage({
      replyToken,
      messages: [{ type: "text", text: "決済機能は準備中です。" }],
    });
    return;
  }
  const user = getUser(userId);
  if (!user?.stripeCustomerId) {
    await client.replyMessage({
      replyToken,
      messages: [{
        type: "text",
        text: "ご契約が確認できません。プラン契約後に領収書が発行されます。",
      }],
    });
    return;
  }
  try {
    const invoices = await listRecentInvoices(user.stripeCustomerId, 5);
    if (invoices.length === 0) {
      await client.replyMessage({
        replyToken,
        messages: [{ type: "text", text: "まだ発行された領収書がありません。" }],
      });
      return;
    }
    const lines = ["📄 直近の領収書", ""];
    for (const inv of invoices) {
      const date = new Date(inv.createdAt).toLocaleDateString("ja-JP", {
        year: "numeric", month: "2-digit", day: "2-digit",
      });
      const price = `¥${inv.amount.toLocaleString()}`;
      const status = inv.status === "paid" ? "支払済" : inv.status ?? "";
      const url = inv.pdfUrl ?? inv.hostedUrl ?? "";
      lines.push(`・${date} ${price} ${status}`);
      if (url) lines.push(`  ${url}`);
    }
    lines.push("", "※PDFリンクから領収書をダウンロードできます");
    await client.replyMessage({
      replyToken,
      messages: [{ type: "text", text: lines.join("\n") }],
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error("[commands] receipts error:", err);
    await client.replyMessage({
      replyToken,
      messages: [{ type: "text", text: `領収書の取得に失敗しました。\n${msg}` }],
    });
  }
}

/** 「使用量」→ 今月の送信数 */
async function handleUsage(client: Client, userId: string, replyToken: string): Promise<void> {
  const user = getUser(userId);
  const plan = user?.plan ?? "trial";
  const used = getMonthlySendCount(userId);
  const limit = getPlanLimit(plan);
  const remain = Math.max(0, limit - used);
  const now = new Date();
  const daysLeft = new Date(now.getFullYear(), now.getMonth() + 1, 0).getDate() - now.getDate();
  await client.replyMessage({
    replyToken,
    messages: [{
      type: "text",
      text: [
        `📈 今月の使用状況`,
        "",
        `プラン: ${plan}`,
        `送信: ${used} / ${limit}通（残り ${remain}通）`,
        `リセットまで ${daysLeft}日`,
      ].join("\n"),
    }],
  });
}

/** 「ステータス」→ プラン状態＋設定 */
async function handleStatus(client: Client, userId: string, replyToken: string): Promise<void> {
  const user = getUser(userId);
  if (!user) {
    await client.replyMessage({ replyToken, messages: [{ type: "text", text: "ユーザー情報が見つかりません。" }] });
    return;
  }
  const expiry = user.planExpiresAt
    ? new Date(user.planExpiresAt).toLocaleDateString("ja-JP", { year: "numeric", month: "2-digit", day: "2-digit" })
    : "—";
  const lines = [
    "📋 ステータス",
    "",
    `呼び名: ${user.displayName ?? "（未設定）"}`,
    `プラン: ${user.plan}`,
    `次回更新/期限: ${expiry}`,
    `朝のブリーフィング: ${user.briefingHour === 0 ? "なし" : `${user.briefingHour}時`}`,
  ];
  await client.replyMessage({
    replyToken,
    messages: [{ type: "text", text: lines.join("\n") }],
  });
}

/** 「ヘルプ」→ 使えるコマンド一覧 */
async function handleHelp(client: Client, replyToken: string): Promise<void> {
  const text = [
    "📖 使い方ガイド",
    "",
    "━━ 基本 ━━",
    "AIに話しかけるだけでOK。例：",
    "・「今日の重要メール教えて」",
    "・「田中さんに承諾の返信して」",
    "・「来週の予定まとめて」",
    "・「30分後に電話するってリマインドして」",
    "",
    "━━ コマンド一覧 ━━",
    "「設定」: 呼び名・ブリーフィング時刻を変更",
    "「プラン」: 有料プランを選ぶ",
    "「使用量」: 今月の送信数を確認",
    "「ステータス」: 現在のプラン・設定を確認",
    "「解約」: 有料プランの解約・カード変更",
    "「領収書」: 直近の請求書PDFリンク",
    "「プロモ コード」: プロモコード適用",
    "「ヘルプ」: このガイドを表示",
    "",
    "━━ ブリーフィング ━━",
    "毎朝 設定した時刻（7/8/9時）にその日の要対応メールと予定を自動で送ります。",
    "昼12時・夜18時にも差分をお届け。",
  ].join("\n");
  await client.replyMessage({
    replyToken,
    messages: [{ type: "text", text }],
  });
}

/** メッセージがコマンドならハンドルして true を返す */
export async function handleCommand(
  client: Client,
  userId: string,
  text: string,
  replyToken: string,
): Promise<boolean> {
  const trimmed = text.trim();

  if (trimmed === "プラン") {
    await handlePlanList(client, replyToken);
    return true;
  }

  const planSelectMatch = trimmed.match(/^プラン選択[:：](.+)$/);
  if (planSelectMatch && planSelectMatch[1]) {
    await handlePlanSelect(client, userId, planSelectMatch[1].trim(), replyToken);
    return true;
  }

  if (trimmed === "解約") {
    await handleCancel(client, userId, replyToken);
    return true;
  }

  const promoMatch = trimmed.match(/^プロモ[\s:：](.+)$/);
  if (promoMatch && promoMatch[1]) {
    await handlePromo(client, userId, promoMatch[1], replyToken);
    return true;
  }

  if (trimmed === "使用量") {
    await handleUsage(client, userId, replyToken);
    return true;
  }

  if (trimmed === "領収書" || trimmed === "請求書") {
    await handleReceipts(client, userId, replyToken);
    return true;
  }

  if (trimmed === "ステータス") {
    await handleStatus(client, userId, replyToken);
    return true;
  }

  if (trimmed === "ヘルプ" || trimmed === "help" || trimmed === "使い方") {
    await handleHelp(client, replyToken);
    return true;
  }

  return false;
}
