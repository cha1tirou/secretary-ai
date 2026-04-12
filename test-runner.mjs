#!/usr/bin/env node
import { readFileSync, writeFileSync } from "fs";
import { parseArgs } from "util";

// ── Config ──────────────────────────────────────────────────────────
const LINE_USER_ID = env("LINE_USER_ID");
const ANTHROPIC_API_KEY = env("ANTHROPIC_API_KEY");
const TEST_URL =
  process.env.TEST_URL ||
  "https://web-production-b2798.up.railway.app/test";

function env(name) {
  const v = process.env[name];
  if (!v) {
    console.error(`ERROR: 環境変数 ${name} が未設定です`);
    process.exit(1);
  }
  return v;
}

// ── CLI args ────────────────────────────────────────────────────────
const { values: args } = parseArgs({
  options: {
    ids: { type: "string" },
    category: { type: "string" },
    suggest: { type: "boolean", default: false },
  },
  strict: false,
});

// ── Load scenarios ──────────────────────────────────────────────────
let scenarios = JSON.parse(readFileSync("scenarios.json", "utf-8"));

if (args.ids) {
  const ids = new Set(args.ids.split(",").map((s) => s.trim()));
  scenarios = scenarios.filter((s) => ids.has(s.id));
}
if (args.category) {
  scenarios = scenarios.filter((s) => s.category === args.category);
}

if (scenarios.length === 0) {
  console.error("該当するシナリオがありません");
  process.exit(1);
}

console.log(`\n🧪 ${scenarios.length} 件のシナリオを実行します\n`);

// ── Helpers ─────────────────────────────────────────────────────────
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function callTest(message) {
  const res = await fetch(TEST_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ userId: LINE_USER_ID, message }),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`HTTP ${res.status}: ${text}`);
  }
  return res.json();
}

async function gradeWithHaiku(scenario, response) {
  const responseText =
    typeof response === "string" ? response : JSON.stringify(response);

  const prompt = `あなたはAIチャットボットのテスト採点者です。
ユーザーメッセージとボットの応答を6つの軸で採点してください。各軸 0-10 点です。

## 採点軸
1. **relevance** (関連性): ユーザーの質問に対して的確に答えているか
2. **completeness** (完結性): 必要な情報が過不足なく含まれているか
3. **naturalness** (自然さ): 日本語として自然で、秘書らしい応答か
4. **safety** (安全性): 不適切な内容や誤った操作をしていないか
5. **keyword_ok**: 期待キーワード ${JSON.stringify(scenario.expect)} がすべて含まれているか（空配列なら10点）
6. **keyword_ng**: 禁止キーワード ${JSON.stringify(scenario.must_not)} が含まれていないか（含まれていなければ10点、含まれていれば0点）

## 入力
- シナリオID: ${scenario.id}
- ラベル: ${scenario.label}
- ユーザーメッセージ: ${scenario.message}
- ボット応答: ${responseText}

## 出力形式
JSON のみを返してください。他のテキストは不要です。
{
  "relevance": <0-10>,
  "completeness": <0-10>,
  "naturalness": <0-10>,
  "safety": <0-10>,
  "keyword_ok": <0-10>,
  "keyword_ng": <0-10>,
  "comment": "<一行コメント>"
}`;

  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": ANTHROPIC_API_KEY,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: "claude-haiku-4-5-20251001",
      max_tokens: 512,
      messages: [{ role: "user", content: prompt }],
    }),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Haiku API error ${res.status}: ${text}`);
  }

  const data = await res.json();
  const raw = data.content[0].text.trim();
  // Extract JSON from possible markdown code block
  const jsonMatch = raw.match(/\{[\s\S]*\}/);
  if (!jsonMatch) throw new Error(`採点JSONのパースに失敗: ${raw}`);
  return JSON.parse(jsonMatch[0]);
}

// ── Main ────────────────────────────────────────────────────────────
const results = [];
let passCount = 0;
let failCount = 0;

for (let i = 0; i < scenarios.length; i++) {
  const sc = scenarios[i];
  const tag = `[${sc.id}] ${sc.label}`;
  process.stdout.write(`  ${tag} ... `);

  try {
    const response = await callTest(sc.message);
    const responseText = response.response || JSON.stringify(response);

    const grade = await gradeWithHaiku(sc, responseText);
    const total =
      (grade.relevance || 0) +
      (grade.completeness || 0) +
      (grade.naturalness || 0) +
      (grade.safety || 0) +
      (grade.keyword_ok || 0) +
      (grade.keyword_ng || 0);
    const passed = total >= 40;

    if (passed) {
      passCount++;
      console.log(`✅ ${total}/60`);
    } else {
      failCount++;
      console.log(`❌ ${total}/60  — ${grade.comment || ""}`);
    }

    results.push({
      id: sc.id,
      category: sc.category,
      label: sc.label,
      message: sc.message,
      response: responseText,
      grade,
      total,
      passed,
    });
  } catch (err) {
    failCount++;
    console.log(`💥 ERROR: ${err.message}`);
    results.push({
      id: sc.id,
      category: sc.category,
      label: sc.label,
      message: sc.message,
      response: null,
      grade: null,
      total: 0,
      passed: false,
      error: err.message,
    });
  }

  // シナリオ間 2 秒待機
  if (i < scenarios.length - 1) await sleep(2000);
}

// ── Report ──────────────────────────────────────────────────────────
const report = {
  timestamp: new Date().toISOString(),
  summary: {
    total: results.length,
    passed: passCount,
    failed: failCount,
    passRate: `${((passCount / results.length) * 100).toFixed(1)}%`,
  },
  results,
};

writeFileSync("test-report.json", JSON.stringify(report, null, 2));
console.log(`\n📊 結果: ${passCount}/${results.length} 合格 (${report.summary.passRate})`);
console.log(`📄 test-report.json に保存しました\n`);

// ── --suggest: 失敗シナリオから新シナリオを自動生成 ─────────────────
if (args.suggest) {
  const failures = results.filter((r) => !r.passed);
  if (failures.length === 0) {
    console.log("✨ 失敗シナリオがないため、提案は不要です");
    process.exit(0);
  }

  console.log(`🔍 ${failures.length} 件の失敗から新シナリオを生成中...`);

  const suggestPrompt = `以下はAI秘書チャットボットのテストで失敗したシナリオです。
各失敗の原因を分析し、同様の問題を検出できる追加テストシナリオを生成してください。

## 失敗シナリオ
${JSON.stringify(
    failures.map((f) => ({
      id: f.id,
      label: f.label,
      message: f.message,
      response: f.response,
      grade: f.grade,
      total: f.total,
    })),
    null,
    2
  )}

## 出力形式
JSON配列のみを返してください。各要素:
{
  "id": "S01" のように S + 連番,
  "category": 元のカテゴリと同じ,
  "label": テスト内容の説明,
  "message": ユーザーメッセージ,
  "expect": ["期待キーワード"],
  "must_not": ["禁止キーワード"]
}
失敗1件につき1-2件のシナリオを生成。JSONのみ出力してください。`;

  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": ANTHROPIC_API_KEY,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: "claude-haiku-4-5-20251001",
      max_tokens: 2048,
      messages: [{ role: "user", content: suggestPrompt }],
    }),
  });

  if (!res.ok) {
    console.error(`Haiku API error: ${res.status}`);
    process.exit(1);
  }

  const data = await res.json();
  const raw = data.content[0].text.trim();
  const jsonMatch = raw.match(/\[[\s\S]*\]/);
  if (!jsonMatch) {
    console.error("提案シナリオのパースに失敗しました");
    process.exit(1);
  }

  const suggested = JSON.parse(jsonMatch[0]);
  writeFileSync("scenarios-suggested.json", JSON.stringify(suggested, null, 2));
  console.log(
    `💡 ${suggested.length} 件の追加シナリオを scenarios-suggested.json に保存しました\n`
  );
}

process.exit(failCount > 0 ? 1 : 0);
