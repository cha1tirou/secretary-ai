import Stripe from "stripe";

let stripeClient: Stripe | null = null;

/** Stripeクライアント（未設定なら null）。未設定時は「準備中」応答で運用する。 */
export function getStripe(): Stripe | null {
  if (stripeClient) return stripeClient;
  const key = process.env["STRIPE_SECRET_KEY"];
  if (!key) return null;
  stripeClient = new Stripe(key);
  return stripeClient;
}

export function isStripeEnabled(): boolean {
  return !!process.env["STRIPE_SECRET_KEY"];
}

export function getPriceIdForPlan(plan: "lite" | "standard" | "pro"): string | null {
  const map: Record<string, string | undefined> = {
    lite: process.env["STRIPE_PRICE_LITE"],
    standard: process.env["STRIPE_PRICE_STANDARD"],
    pro: process.env["STRIPE_PRICE_PRO"],
  };
  return map[plan] ?? null;
}

function getBaseUrl(): string {
  return process.env["APP_BASE_URL"] ?? "https://ai-hisho.net";
}

/** 既存Customerがなければ作成してIDを返す */
export async function ensureStripeCustomer(params: {
  userId: string;
  email: string | null;
  existingCustomerId: string | null;
}): Promise<string> {
  const stripe = getStripe();
  if (!stripe) throw new Error("Stripeが未設定です");
  if (params.existingCustomerId) return params.existingCustomerId;
  const createParams: Stripe.CustomerCreateParams = {
    metadata: { line_user_id: params.userId },
  };
  if (params.email) createParams.email = params.email;
  const customer = await stripe.customers.create(createParams);
  return customer.id;
}

export async function createCheckoutSession(params: {
  userId: string;
  customerId: string;
  plan: "lite" | "standard" | "pro";
}): Promise<string> {
  const stripe = getStripe();
  if (!stripe) throw new Error("Stripeが未設定です");
  const priceId = getPriceIdForPlan(params.plan);
  if (!priceId) throw new Error(`Price ID が未設定です: ${params.plan}`);
  const baseUrl = getBaseUrl();
  const session = await stripe.checkout.sessions.create({
    mode: "subscription",
    customer: params.customerId,
    line_items: [{ price: priceId, quantity: 1 }],
    success_url: `${baseUrl}/billing/success`,
    cancel_url: `${baseUrl}/billing/cancel`,
    metadata: { line_user_id: params.userId, plan: params.plan },
    subscription_data: {
      metadata: { line_user_id: params.userId, plan: params.plan },
    },
    allow_promotion_codes: false,
  });
  if (!session.url) throw new Error("Stripe Checkout URLの取得に失敗しました");
  return session.url;
}

export async function createPortalSession(customerId: string): Promise<string> {
  const stripe = getStripe();
  if (!stripe) throw new Error("Stripeが未設定です");
  const session = await stripe.billingPortal.sessions.create({
    customer: customerId,
    return_url: `${getBaseUrl()}/billing/portal-return`,
  });
  return session.url;
}

/** Stripe webhook の署名検証付きパース */
export function constructWebhookEvent(payload: string, signature: string): Stripe.Event {
  const stripe = getStripe();
  if (!stripe) throw new Error("Stripeが未設定です");
  const secret = process.env["STRIPE_WEBHOOK_SECRET"];
  if (!secret) throw new Error("STRIPE_WEBHOOK_SECRET が未設定です");
  return stripe.webhooks.constructEvent(payload, signature, secret);
}

/** サブスクリプションから plan と期限を判定 */
export function resolvePlanFromSubscription(subscription: Stripe.Subscription): {
  plan: "lite" | "standard" | "pro" | null;
  periodEnd: string;
} {
  const item = subscription.items.data[0];
  const priceId = item?.price.id;
  let plan: "lite" | "standard" | "pro" | null = null;
  if (priceId === process.env["STRIPE_PRICE_LITE"]) plan = "lite";
  else if (priceId === process.env["STRIPE_PRICE_STANDARD"]) plan = "standard";
  else if (priceId === process.env["STRIPE_PRICE_PRO"]) plan = "pro";

  // current_period_end はSubscriptionItemから取る方式に stripe v18+ で変更されている
  const periodEndUnix =
    (item as { current_period_end?: number } | undefined)?.current_period_end
    ?? (subscription as unknown as { current_period_end?: number }).current_period_end;
  const periodEnd = periodEndUnix
    ? new Date(periodEndUnix * 1000).toISOString()
    : new Date(Date.now() + 31 * 24 * 3600 * 1000).toISOString();

  return { plan, periodEnd };
}
