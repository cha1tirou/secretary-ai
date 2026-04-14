import { Hono } from "hono";
import { basicAuth } from "hono/basic-auth";
import {
  createPromoCode,
  listPromoCodes,
  setPromoCodeActive,
  listAllUsersWithStatus,
} from "../db/queries.js";

const admin = new Hono();

// Basic 認証（ADMIN_PASSWORD が設定されている場合のみ有効化）
admin.use("/admin/*", async (c, next) => {
  const password = process.env["ADMIN_PASSWORD"];
  if (!password) {
    return c.text("ADMIN_PASSWORD が未設定のため、管理画面は無効です。", 503);
  }
  const auth = basicAuth({ username: "admin", password });
  return auth(c, next);
});

function escape(s: string | null | undefined): string {
  if (s == null) return "";
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function page(title: string, body: string): string {
  return `<!DOCTYPE html>
<html lang="ja"><head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escape(title)}</title>
<style>
* { box-sizing: border-box; margin: 0; padding: 0; }
body { font-family: -apple-system, system-ui, "Segoe UI", sans-serif; background: #0f172a; color: #e2e8f0; padding: 24px; line-height: 1.6; }
.container { max-width: 1100px; margin: 0 auto; }
h1 { font-size: 22px; margin-bottom: 8px; color: #fff; }
h2 { font-size: 16px; margin: 32px 0 12px; color: #94a3b8; text-transform: uppercase; letter-spacing: .08em; }
nav a { color: #22c55e; margin-right: 16px; text-decoration: none; font-weight: 600; font-size: 14px; }
nav a:hover { text-decoration: underline; }
table { width: 100%; border-collapse: collapse; background: rgba(255,255,255,.03); border-radius: 8px; overflow: hidden; margin-bottom: 24px; font-size: 13px; }
th, td { padding: 10px 12px; text-align: left; border-bottom: 1px solid rgba(255,255,255,.06); }
th { background: rgba(255,255,255,.05); font-weight: 600; color: #cbd5e1; font-size: 12px; text-transform: uppercase; letter-spacing: .06em; }
td { color: #e2e8f0; }
.tag { display: inline-block; padding: 2px 8px; border-radius: 100px; font-size: 11px; font-weight: 600; }
.tag-active { background: #16a34a; color: #fff; }
.tag-inactive { background: #64748b; color: #fff; }
.tag-plan { background: rgba(34,197,94,.2); color: #22c55e; }
form.inline { display: inline; }
button, input[type=submit] { background: #22c55e; color: #000; border: none; padding: 6px 12px; border-radius: 6px; font-weight: 600; font-size: 12px; cursor: pointer; }
button.secondary { background: #64748b; color: #fff; }
button:hover { filter: brightness(1.1); }
form.new { background: rgba(255,255,255,.04); padding: 16px; border-radius: 8px; display: grid; grid-template-columns: repeat(6, 1fr); gap: 10px; align-items: end; margin-bottom: 24px; }
form.new label { font-size: 11px; color: #94a3b8; display: block; margin-bottom: 4px; }
form.new input, form.new select { background: #1e293b; color: #fff; border: 1px solid rgba(255,255,255,.1); padding: 8px; border-radius: 6px; width: 100%; font-size: 13px; }
form.new .full { grid-column: span 6; }
.submit-row { grid-column: span 6; text-align: right; }
.submit-row button { padding: 10px 20px; }
.note { color: #64748b; font-size: 12px; margin-bottom: 12px; }
.small { font-size: 11px; color: #64748b; }
</style>
</head><body>
<div class="container">
<nav>
  <a href="/admin">プロモコード</a>
  <a href="/admin/users">ユーザー</a>
</nav>
<h1>${escape(title)}</h1>
${body}
</div></body></html>`;
}

admin.get("/admin", (c) => {
  const codes = listPromoCodes();
  const rows = codes.length === 0
    ? `<tr><td colspan="9" style="text-align:center;color:#64748b;padding:32px;">プロモコードはまだありません</td></tr>`
    : codes.map((pc) => {
        const usedLabel = pc.maxUses === null ? `${pc.usedCount} / ∞` : `${pc.usedCount} / ${pc.maxUses}`;
        const exp = pc.expiresAt ? new Date(pc.expiresAt).toLocaleDateString("ja-JP") : "—";
        const toggleAction = pc.active ? "deactivate" : "activate";
        const toggleLabel = pc.active ? "停止" : "再開";
        return `<tr>
          <td><code>${escape(pc.code)}</code></td>
          <td><span class="tag tag-plan">${escape(pc.plan)}</span></td>
          <td>${pc.durationMonths}ヶ月</td>
          <td>${usedLabel}</td>
          <td>${exp}</td>
          <td>${pc.active ? '<span class="tag tag-active">有効</span>' : '<span class="tag tag-inactive">停止</span>'}</td>
          <td>${escape(pc.note ?? "")}</td>
          <td class="small">${escape(pc.createdAt)}</td>
          <td>
            <form class="inline" method="post" action="/admin/promo/${pc.id}/${toggleAction}">
              <button class="secondary">${toggleLabel}</button>
            </form>
          </td>
        </tr>`;
      }).join("");

  const body = `
<p class="note">ユーザーが LINE で「プロモ コード」と送ると適用されます。期間は付与時点から${""}カウント。</p>

<form class="new" method="post" action="/admin/promo">
  <div><label>コード</label><input name="code" required placeholder="INFLUENCER_TAROU" pattern="[A-Za-z0-9_-]+"></div>
  <div><label>プラン</label><select name="plan">
    <option value="lite">Lite</option>
    <option value="standard">Standard</option>
    <option value="pro" selected>Pro</option>
  </select></div>
  <div><label>期間(月)</label><input name="duration_months" type="number" min="1" value="3" required></div>
  <div><label>最大利用数</label><input name="max_uses" type="number" min="1" placeholder="無制限"></div>
  <div><label>コード有効期限</label><input name="expires_at" type="date" placeholder="無期限"></div>
  <div><label>メモ</label><input name="note" placeholder="太郎さん向け"></div>
  <div class="submit-row"><button>コードを発行</button></div>
</form>

<h2>発行済みコード</h2>
<table>
  <tr><th>コード</th><th>プラン</th><th>期間</th><th>使用</th><th>コード失効日</th><th>状態</th><th>メモ</th><th>作成</th><th></th></tr>
  ${rows}
</table>`;
  return c.html(page("プロモコード管理", body));
});

admin.post("/admin/promo", async (c) => {
  const form = await c.req.parseBody();
  const code = String(form["code"] ?? "").trim().toUpperCase();
  const plan = String(form["plan"] ?? "pro");
  const durationMonths = Number(form["duration_months"] ?? 1);
  const maxUsesRaw = String(form["max_uses"] ?? "").trim();
  const maxUses = maxUsesRaw === "" ? null : Number(maxUsesRaw);
  const expiresAtRaw = String(form["expires_at"] ?? "").trim();
  const expiresAt = expiresAtRaw === "" ? null : new Date(expiresAtRaw + "T23:59:59+09:00").toISOString();
  const note = String(form["note"] ?? "").trim() || null;

  if (!code || !/^[A-Z0-9_-]+$/.test(code)) {
    return c.html(page("エラー", `<p>コードは英数字・アンダースコア・ハイフンのみ可能です。</p><p><a href="/admin">戻る</a></p>`), 400);
  }
  if (!["lite", "standard", "pro"].includes(plan)) {
    return c.html(page("エラー", `<p>無効なプランです。</p>`), 400);
  }
  if (!Number.isFinite(durationMonths) || durationMonths < 1) {
    return c.html(page("エラー", `<p>期間は1ヶ月以上で指定してください。</p>`), 400);
  }

  try {
    createPromoCode({ code, plan, durationMonths, maxUses, expiresAt, note });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return c.html(page("エラー", `<p>発行に失敗しました: ${escape(msg)}</p><p><a href="/admin">戻る</a></p>`), 400);
  }
  return c.redirect("/admin");
});

admin.post("/admin/promo/:id/deactivate", (c) => {
  setPromoCodeActive(Number(c.req.param("id")), false);
  return c.redirect("/admin");
});
admin.post("/admin/promo/:id/activate", (c) => {
  setPromoCodeActive(Number(c.req.param("id")), true);
  return c.redirect("/admin");
});

admin.get("/admin/users", (c) => {
  const users = listAllUsersWithStatus();
  const rows = users.length === 0
    ? `<tr><td colspan="7" style="text-align:center;color:#64748b;padding:32px;">ユーザーがいません</td></tr>`
    : users.map((u) => {
        const exp = u.planExpiresAt ? new Date(u.planExpiresAt).toLocaleDateString("ja-JP") : "—";
        const created = new Date(u.createdAt).toLocaleDateString("ja-JP");
        return `<tr>
          <td class="small">${escape(u.userId.slice(0, 10))}…</td>
          <td>${escape(u.displayName ?? "")}</td>
          <td>${escape(u.email ?? "")}</td>
          <td><span class="tag tag-plan">${escape(u.plan)}</span></td>
          <td>${exp}</td>
          <td class="small">${u.stripeCustomerId ? "✓" : ""}</td>
          <td class="small">${created}</td>
        </tr>`;
      }).join("");
  const body = `
<table>
  <tr><th>LINE ID</th><th>呼び名</th><th>Email</th><th>プラン</th><th>期限</th><th>Stripe</th><th>登録日</th></tr>
  ${rows}
</table>`;
  return c.html(page(`ユーザー (${users.length})`, body));
});

export { admin };
