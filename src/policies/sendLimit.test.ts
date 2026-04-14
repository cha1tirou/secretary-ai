import { describe, it, expect, beforeAll, beforeEach } from "vitest";

process.env["DB_PATH"] = ":memory:";

// DB_PATH を先に設定してからインポート
const { initDb, getDb, upsertUser, updateUserPlanAndExpiry } = await import("../db/queries.js");
const { canSend, recordSent, buildLimitReachedMessage, buildLowRemainingNote } = await import("./sendLimit.js");

const userId = "U_test";

describe("sendLimit policy", () => {
  beforeAll(() => {
    initDb();
  });

  beforeEach(() => {
    getDb().exec(`DELETE FROM users; DELETE FROM monthly_send_count;`);
    upsertUser(userId, "Tester", "free");
  });

  it("allows send when under limit (free)", () => {
    const check = canSend(userId);
    expect(check.allowed).toBe(true);
    expect(check.limit).toBe(5);
    expect(check.remaining).toBe(5);
    expect(check.used).toBe(0);
  });

  it("denies send when limit reached", () => {
    for (let i = 0; i < 5; i++) recordSent(userId);
    const check = canSend(userId);
    expect(check.allowed).toBe(false);
    expect(check.used).toBe(5);
    expect(check.remaining).toBe(0);
  });

  it("pro plan has 150 limit", () => {
    updateUserPlanAndExpiry(userId, "pro", null);
    expect(canSend(userId).limit).toBe(150);
  });

  it("trial plan has 150 limit (pro相当)", () => {
    updateUserPlanAndExpiry(userId, "trial", null);
    expect(canSend(userId).limit).toBe(150);
  });

  it("lite/standard limits", () => {
    updateUserPlanAndExpiry(userId, "lite", null);
    expect(canSend(userId).limit).toBe(30);
    updateUserPlanAndExpiry(userId, "standard", null);
    expect(canSend(userId).limit).toBe(60);
  });

  it("expired plan falls back to 5通", () => {
    updateUserPlanAndExpiry(userId, "expired", null);
    expect(canSend(userId).limit).toBe(5);
  });

  it("buildLimitReachedMessage includes plan and limit", () => {
    const msg = buildLimitReachedMessage({ allowed: false, used: 5, limit: 5, remaining: 0, plan: "free" });
    expect(msg).toContain("上限");
    expect(msg).toContain("5通");
    expect(msg).toContain("プラン");
  });

  it("buildLowRemainingNote shows note at ≤20%, empty above", () => {
    expect(buildLowRemainingNote({ allowed: true, used: 4, limit: 5, remaining: 1, plan: "free" }))
      .toContain("あと 1通");
    expect(buildLowRemainingNote({ allowed: true, used: 2, limit: 5, remaining: 3, plan: "free" }))
      .toBe("");
    expect(buildLowRemainingNote({ allowed: true, used: 5, limit: 5, remaining: 0, plan: "free" }))
      .toContain("使い切りました");
  });
});
