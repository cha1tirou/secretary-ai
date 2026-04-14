import {
  getUser,
  getMonthlySendCount,
  incrementMonthlySendCount,
  getPlanLimit,
} from "../db/queries.js";

export type SendCheck = {
  allowed: boolean;
  used: number;
  limit: number;
  remaining: number;
  plan: string;
};

/** 送信を許可するか判定（increment はしない） */
export function canSend(userId: string): SendCheck {
  const user = getUser(userId);
  const plan = user?.plan ?? "trial";
  const used = getMonthlySendCount(userId);
  const limit = getPlanLimit(plan);
  const remaining = Math.max(0, limit - used);
  return { allowed: used < limit, used, limit, remaining, plan };
}

/** 送信成功後に呼ぶ */
export function recordSent(userId: string): void {
  incrementMonthlySendCount(userId);
}

/** 上限到達時のメッセージ */
export function buildLimitReachedMessage(check: SendCheck): string {
  const planLabel = check.plan === "free" || check.plan === "expired" ? "Free" : check.plan;
  return [
    `⚠️ 今月の送信上限に達しました（${check.limit}通 / ${planLabel}プラン）`,
    "",
    "・来月1日にリセットされます",
    "・すぐ使い続けたい場合は「プラン」と送ってください",
  ].join("\n");
}

/** 送信後に付加する残量メモ（残量≤20%時のみ返す。それ以外は空） */
export function buildLowRemainingNote(afterSend: SendCheck): string {
  // afterSend は send後の状態（recordSent 後に canSend した結果）
  if (afterSend.limit === 0) return "";
  const ratio = afterSend.remaining / afterSend.limit;
  if (ratio > 0.2) return "";
  if (afterSend.remaining === 0) {
    return "\n\n📈 今月の送信分をすべて使い切りました。来月1日にリセットされます。";
  }
  return `\n\n📈 今月あと ${afterSend.remaining}通 です（${afterSend.used}/${afterSend.limit}）`;
}
