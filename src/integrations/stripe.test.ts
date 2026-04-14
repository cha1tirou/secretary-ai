import { describe, it, expect, beforeEach, vi } from "vitest";
import type Stripe from "stripe";
import { resolvePlanFromSubscription } from "./stripe.js";

describe("resolvePlanFromSubscription", () => {
  beforeEach(() => {
    vi.stubEnv("STRIPE_PRICE_LITE", "price_lite_abc");
    vi.stubEnv("STRIPE_PRICE_STANDARD", "price_std_abc");
    vi.stubEnv("STRIPE_PRICE_PRO", "price_pro_abc");
  });

  const makeSub = (priceId: string, periodEnd: number): Stripe.Subscription =>
    ({
      id: "sub_test",
      items: { data: [{ price: { id: priceId }, current_period_end: periodEnd }] },
    }) as unknown as Stripe.Subscription;

  it("resolves lite from price id", () => {
    const sub = makeSub("price_lite_abc", 1_700_000_000);
    expect(resolvePlanFromSubscription(sub).plan).toBe("lite");
  });

  it("resolves standard from price id", () => {
    const sub = makeSub("price_std_abc", 1_700_000_000);
    expect(resolvePlanFromSubscription(sub).plan).toBe("standard");
  });

  it("resolves pro from price id", () => {
    const sub = makeSub("price_pro_abc", 1_700_000_000);
    expect(resolvePlanFromSubscription(sub).plan).toBe("pro");
  });

  it("returns null for unknown price", () => {
    const sub = makeSub("price_unknown", 1_700_000_000);
    expect(resolvePlanFromSubscription(sub).plan).toBeNull();
  });

  it("converts unix timestamp to ISO periodEnd", () => {
    const sub = makeSub("price_pro_abc", 1_700_000_000);
    const result = resolvePlanFromSubscription(sub);
    expect(new Date(result.periodEnd).getTime()).toBe(1_700_000_000 * 1000);
  });
});
