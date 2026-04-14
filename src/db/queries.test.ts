import { describe, it, expect, beforeAll, beforeEach } from "vitest";

process.env["DB_PATH"] = ":memory:";

const {
  initDb,
  getDb,
  upsertUser,
  createPromoCode,
  getPromoCodeByCode,
  redeemPromoCode,
  countRecentUsage,
  logUsage,
  cleanupOldConversations,
  addConversation,
} = await import("./queries.js");

describe("promo codes", () => {
  beforeAll(() => {
    initDb();
  });

  beforeEach(() => {
    getDb().exec(
      `DELETE FROM promo_codes; DELETE FROM user_promos; DELETE FROM users; DELETE FROM usage_logs;`,
    );
  });

  it("creates and retrieves a promo code", () => {
    const id = createPromoCode({
      code: "TEST1",
      plan: "pro",
      durationMonths: 3,
      maxUses: 10,
      expiresAt: null,
      note: "test",
    });
    expect(id).toBeGreaterThan(0);

    const got = getPromoCodeByCode("TEST1");
    expect(got).toBeDefined();
    expect(got?.plan).toBe("pro");
    expect(got?.durationMonths).toBe(3);
    expect(got?.usedCount).toBe(0);
    expect(got?.maxUses).toBe(10);
    expect(got?.active).toBe(1);
  });

  it("redemption increments usedCount", () => {
    const userId = "U_test";
    upsertUser(userId);
    const id = createPromoCode({
      code: "TEST2",
      plan: "pro",
      durationMonths: 1,
      maxUses: null,
      expiresAt: null,
      note: null,
    });
    redeemPromoCode({
      userId,
      codeId: id,
      plan: "pro",
      expiresAt: new Date(Date.now() + 31 * 24 * 3600 * 1000).toISOString(),
    });
    expect(getPromoCodeByCode("TEST2")?.usedCount).toBe(1);
  });

  it("max_uses=null means unlimited", () => {
    const id = createPromoCode({
      code: "UNLIMITED",
      plan: "lite",
      durationMonths: 1,
      maxUses: null,
      expiresAt: null,
      note: null,
    });
    const got = getPromoCodeByCode("UNLIMITED");
    expect(got?.maxUses).toBeNull();
    expect(id).toBeGreaterThan(0);
  });
});

describe("rate limit via usage_logs", () => {
  beforeAll(() => {
    initDb();
  });

  beforeEach(() => {
    getDb().exec(`DELETE FROM usage_logs;`);
  });

  it("counts recent attempts", () => {
    const userId = "U_ratelimit";
    expect(countRecentUsage(userId, "promo_attempt", 60)).toBe(0);
    logUsage(userId, "promo_attempt");
    logUsage(userId, "promo_attempt");
    logUsage(userId, "promo_attempt");
    expect(countRecentUsage(userId, "promo_attempt", 60)).toBe(3);
  });

  it("separates by action type", () => {
    const userId = "U_sep";
    logUsage(userId, "promo_attempt");
    logUsage(userId, "other_action");
    expect(countRecentUsage(userId, "promo_attempt", 60)).toBe(1);
    expect(countRecentUsage(userId, "other_action", 60)).toBe(1);
  });
});

describe("conversations retention", () => {
  beforeAll(() => {
    initDb();
  });

  beforeEach(() => {
    getDb().exec(`DELETE FROM conversations;`);
  });

  it("deletes conversations older than 30 days", () => {
    const userId = "U_retention";
    // 新しい会話 2件
    addConversation(userId, "user", "new1");
    addConversation(userId, "assistant", "new2");
    // 古い会話を直接挿入（31日前）
    getDb().prepare(
      `INSERT INTO conversations (user_id, role, content, created_at) VALUES (?, ?, ?, datetime('now', '-31 days'))`,
    ).run(userId, "user", "old1");

    const before = getDb().prepare(`SELECT COUNT(*) AS c FROM conversations`).get() as { c: number };
    expect(before.c).toBe(3);

    const deleted = cleanupOldConversations();
    expect(deleted).toBe(1);

    const after = getDb().prepare(`SELECT COUNT(*) AS c FROM conversations`).get() as { c: number };
    expect(after.c).toBe(2);
  });
});
