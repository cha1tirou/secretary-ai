import { Hono } from "hono";
import { google } from "googleapis";
import { upsertUser, upsertGoogleAccount, getGoogleAccountsByUserId, deleteGoogleAccountsByUserId } from "../db/queries.js";
import type { GoogleAccount } from "../types.js";

export function buildAuthUrl(userId: string): string {
  const baseUrl = (process.env["GOOGLE_REDIRECT_URI"] ?? "")
    .replace("/auth/callback", "")
    || "https://web-production-b2798.up.railway.app";
  return `${baseUrl}/auth/start?user=${userId}&label=${encodeURIComponent("アカウント1")}`;
}

export class ReauthRequiredError extends Error {
  public readonly authUrl: string;
  constructor(userId: string, reason: string) {
    const authUrl = buildAuthUrl(userId);
    super(reason);
    this.name = "ReauthRequiredError";
    this.authUrl = authUrl;
  }
}

const auth = new Hono();

const SCOPES = [
  "https://www.googleapis.com/auth/gmail.readonly",
  "https://www.googleapis.com/auth/gmail.send",
  "https://www.googleapis.com/auth/calendar.readonly",
  "https://www.googleapis.com/auth/userinfo.email",
];

function createOAuth2Client() {
  return new google.auth.OAuth2(
    process.env["GOOGLE_CLIENT_ID"],
    process.env["GOOGLE_CLIENT_SECRET"],
    process.env["GOOGLE_REDIRECT_URI"],
  );
}

// Google ログイン画面へ（LINE内ブラウザ対策でHTML経由）
auth.get("/auth/start", (c) => {
  const userId = c.req.query("user");
  if (!userId) {
    return c.text("Missing required parameter: user", 400);
  }

  const label = c.req.query("label") || "default";

  const oauth2Client = createOAuth2Client();
  const state = JSON.stringify({ userId, label });
  const googleAuthUrl = oauth2Client.generateAuthUrl({
    access_type: "offline",
    scope: SCOPES,
    prompt: "consent",
    state,
  });

  const escapedUrl = googleAuthUrl.replace(/&/g, "&amp;").replace(/"/g, "&quot;");
  const jsUrl = googleAuthUrl.replace(/\\/g, "\\\\").replace(/'/g, "\\'");

  // All Japanese text uses Unicode escapes to prevent mojibake in template literals
  const title = "Google\u30A2\u30AB\u30A6\u30F3\u30C8\u9023\u643A"; // Googleアカウント連携
  const step1 = "\u300C\u0055\u0052\u004C\u3092\u30B3\u30D4\u30FC\u300D\u30DC\u30BF\u30F3\u3092\u30BF\u30C3\u30D7"; // 「URLをコピー」ボタンをタップ
  const step2 = "iPhone\u306ESafari\u3092\u958B\u304F"; // iPhoneのSafariを開く
  const step3 = "\u30A2\u30C9\u30EC\u30B9\u30D0\u30FC\u306B\u8CBC\u308A\u4ED8\u3051\u3066\u30A2\u30AF\u30BB\u30B9"; // アドレスバーに貼り付けてアクセス
  const step4 = "Google\u30ED\u30B0\u30A4\u30F3\u5B8C\u4E86\u5F8C\u3001LINE\u306B\u623B\u308B"; // Googleログイン完了後、LINEに戻る
  const btnLabel = "URL\u3092\u30B3\u30D4\u30FC"; // URLをコピー
  const copiedLabel = "\u30B3\u30D4\u30FC\u3057\u307E\u3057\u305F\uFF01\u2713"; // コピーしました！✓
  const fallbackLabel = "URL\u3092\u9078\u629E\u3057\u307E\u3057\u305F \u2014 \u9577\u62BC\u3057\u3067\u30B3\u30D4\u30FC"; // URLを選択しました — 長押しでコピー
  const stepsTitle = "\u624B\u9806"; // 手順

  return c.html(`<!DOCTYPE html>
<html lang="ja">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${title}</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, "Hiragino Sans", sans-serif;
      background: #fff;
      min-height: 100vh;
      display: flex;
      align-items: center;
      justify-content: center;
      padding: 24px;
    }
    .card { max-width: 400px; width: 100%; }
    .icon { font-size: 48px; text-align: center; margin-bottom: 16px; }
    h1 { font-size: 20px; text-align: center; margin-bottom: 20px; color: #333; }
    .steps {
      background: #f9f9f9;
      border-radius: 12px;
      padding: 20px;
      margin-bottom: 20px;
    }
    .steps h2 { font-size: 14px; color: #333; margin-bottom: 12px; }
    .step {
      display: flex;
      align-items: flex-start;
      gap: 10px;
      margin-bottom: 10px;
      font-size: 14px;
      color: #444;
      line-height: 1.5;
    }
    .step:last-child { margin-bottom: 0; }
    .step-num {
      background: #06C755;
      color: #fff;
      width: 22px; height: 22px;
      border-radius: 50%;
      display: flex;
      align-items: center;
      justify-content: center;
      font-size: 12px;
      font-weight: bold;
      flex-shrink: 0;
    }
    .btn {
      display: block;
      width: 100%;
      padding: 16px;
      font-size: 16px;
      font-weight: bold;
      color: #fff;
      background: #06C755;
      border: none;
      border-radius: 12px;
      text-align: center;
      cursor: pointer;
      margin-bottom: 16px;
    }
    .url-box {
      background: #f5f5f5;
      border: 1px solid #ddd;
      border-radius: 8px;
      padding: 12px;
      font-size: 11px;
      word-break: break-all;
      color: #333;
      line-height: 1.5;
      user-select: all;
      -webkit-user-select: all;
    }
  </style>
</head>
<body>
  <div class="card">
    <div class="icon">\uD83D\uDD17</div>
    <h1>${title}</h1>
    <div class="steps">
      <h2>${stepsTitle}</h2>
      <div class="step"><span class="step-num">1</span><span>${step1}</span></div>
      <div class="step"><span class="step-num">2</span><span>${step2}</span></div>
      <div class="step"><span class="step-num">3</span><span>${step3}</span></div>
      <div class="step"><span class="step-num">4</span><span>${step4}</span></div>
    </div>
    <button class="btn" id="copyBtn" onclick="copyUrl()">${btnLabel}</button>
    <div class="url-box" id="urlText">${escapedUrl}</div>
  </div>
  <script>
    function copyUrl() {
      var btn = document.getElementById('copyBtn');
      navigator.clipboard.writeText('${jsUrl}')
        .then(function() {
          btn.textContent = '${copiedLabel}';
          btn.style.background = '#888';
        })
        .catch(function() {
          var range = document.createRange();
          range.selectNodeContents(document.getElementById('urlText'));
          var sel = window.getSelection();
          sel.removeAllRanges();
          sel.addRange(range);
          btn.textContent = '${fallbackLabel}';
          btn.style.background = '#888';
        });
    }
  </script>
</body>
</html>`);
});

// コールバック: トークンをDBに保存
auth.get("/auth/callback", async (c) => {
  const code = c.req.query("code");
  if (!code) {
    return c.text("Missing authorization code", 400);
  }

  const stateRaw = c.req.query("state");
  if (!stateRaw) {
    return c.text("Missing state parameter", 400);
  }

  let userId: string;
  let label: string;
  try {
    const parsed = JSON.parse(stateRaw) as { userId: string; label?: string };
    userId = parsed.userId;
    label = parsed.label || "default";
  } catch {
    return c.text("Invalid state parameter", 400);
  }

  const oauth2Client = createOAuth2Client();

  try {
    const { tokens } = await oauth2Client.getToken(code);
    oauth2Client.setCredentials(tokens);

    // Googleアカウントのメールアドレスを取得
    let email: string | null = null;
    try {
      const oauth2 = google.oauth2({ version: "v2", auth: oauth2Client });
      const userInfo = await oauth2.userinfo.get();
      email = userInfo.data.email ?? null;
    } catch {
      console.warn("[auth] メールアドレス取得失敗（続行）");
    }

    upsertUser(userId);

    const tokenJson = JSON.stringify(tokens);
    upsertGoogleAccount(userId, label, email, tokenJson, tokenJson);

    // 後方互換: users テーブルにも最初のアカウントのトークンを保存
    const { updateUserTokens } = await import("../db/queries.js");
    updateUserTokens(userId, { gmailToken: tokenJson, gcalToken: tokenJson });

    return c.html(`
      <h1>認証成功</h1>
      <p>Google連携が完了しました（ラベル: ${label}${email ? `、${email}` : ""}）。<br>このページを閉じてLINEに戻ってください。</p>
    `);
  } catch (err) {
    console.error("OAuth callback error:", err);
    return c.text("認証に失敗しました", 500);
  }
});

/**
 * DBからトークンを復元してOAuth2クライアントを返す。
 * 期限切れならrefreshし、新しいトークンをDBに書き戻す。
 * google_accounts テーブルから取得する。
 */
export async function getAuthedClient(
  userId: string,
  tokenField: "gmailToken" | "gcalToken",
  account?: GoogleAccount,
): Promise<InstanceType<typeof google.auth.OAuth2>> {
  const { getUser, updateUserTokens } = await import("../db/queries.js");

  let raw: string | null = null;

  if (account) {
    raw = account[tokenField];
  } else {
    // google_accounts から最初のアカウントを探す
    const accounts = getGoogleAccountsByUserId(userId);
    if (accounts.length > 0 && accounts[0]) {
      raw = accounts[0][tokenField];
    }
    // フォールバック: users テーブルから取得
    if (!raw) {
      const user = getUser(userId);
      if (!user) throw new Error(`User not found: ${userId}`);
      raw = user[tokenField];
    }
  }

  if (!raw) throw new Error(`No ${tokenField} for user ${userId}. Run /auth/start first.`);

  const tokens = JSON.parse(raw);
  const oauth2Client = createOAuth2Client();
  oauth2Client.setCredentials(tokens);

  // 期限切れならrefresh
  const expiry = tokens.expiry_date as number | undefined;
  if (expiry && expiry < Date.now() + 60_000) {
    console.log("[auth] token expired, refreshing");
    try {
      const { credentials } = await oauth2Client.refreshAccessToken();
      oauth2Client.setCredentials(credentials);
      const updated = JSON.stringify(credentials);

      // google_accounts を更新
      if (account) {
        const { upsertGoogleAccount } = await import("../db/queries.js");
        upsertGoogleAccount(account.userId, account.label, account.email, updated, updated);
      } else {
        updateUserTokens(userId, { [tokenField]: updated } as {
          gmailToken?: string;
          gcalToken?: string;
        });
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (/invalid_grant|Token has been expired|Token has been revoked/i.test(msg)) {
        console.error(`[auth] token refresh failed (${userId}): ${msg}`);
        deleteGoogleAccountsByUserId(userId);
        updateUserTokens(userId, { gmailToken: null, gcalToken: null });
        throw new ReauthRequiredError(userId, msg);
      }
      throw err;
    }
  }

  return oauth2Client;
}

export { auth, createOAuth2Client, SCOPES };
