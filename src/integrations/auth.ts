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

  return c.html(`<!DOCTYPE html>
<html lang="ja">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Googleアカウント連携</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, "Hiragino Sans", sans-serif;
      background: #f5f5f5;
      min-height: 100vh;
      display: flex;
      align-items: center;
      justify-content: center;
      padding: 24px;
    }
    .card {
      background: #fff;
      border-radius: 16px;
      padding: 32px 24px;
      max-width: 400px;
      width: 100%;
      text-align: center;
      box-shadow: 0 2px 12px rgba(0,0,0,0.08);
    }
    .icon { font-size: 48px; margin-bottom: 16px; }
    h1 { font-size: 20px; margin-bottom: 12px; color: #333; }
    p { font-size: 14px; color: #666; line-height: 1.6; margin-bottom: 24px; }
    .btn {
      display: block;
      width: 100%;
      padding: 16px;
      font-size: 16px;
      font-weight: bold;
      color: #fff;
      background: #34a853;
      border: none;
      border-radius: 12px;
      text-decoration: none;
      cursor: pointer;
    }
    .note { font-size: 12px; color: #aaa; margin-top: 16px; }
  </style>
</head>
<body>
  <div class="card">
    <div class="icon">🔗</div>
    <h1>Googleアカウント連携</h1>
    <p>LINEのブラウザではGoogleログインができません。<br>下のボタンをタップしてSafariで開いてください。</p>
    <a class="btn" href="${googleAuthUrl}">Safariで開く</a>
    <p class="note">SafariまたはChromeが開きます</p>
  </div>
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
