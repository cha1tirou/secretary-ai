import { Hono } from "hono";
import { google } from "googleapis";
import { upsertUser, updateUserTokens } from "../db/queries.js";

const auth = new Hono();

const SCOPES = [
  "https://www.googleapis.com/auth/gmail.readonly",
  "https://www.googleapis.com/auth/gmail.send",
  "https://www.googleapis.com/auth/calendar.readonly",
];

function createOAuth2Client() {
  return new google.auth.OAuth2(
    process.env["GOOGLE_CLIENT_ID"],
    process.env["GOOGLE_CLIENT_SECRET"],
    process.env["GOOGLE_REDIRECT_URI"],
  );
}

// Google ログイン画面へリダイレクト
auth.get("/auth/start", (c) => {
  const oauth2Client = createOAuth2Client();
  const url = oauth2Client.generateAuthUrl({
    access_type: "offline",
    scope: SCOPES,
    prompt: "consent",
  });
  return c.redirect(url);
});

// コールバック: トークンをDBに保存
auth.get("/auth/callback", async (c) => {
  const code = c.req.query("code");
  if (!code) {
    return c.text("Missing authorization code", 400);
  }

  const oauth2Client = createOAuth2Client();

  try {
    const { tokens } = await oauth2Client.getToken(code);
    oauth2Client.setCredentials(tokens);

    // LINE_USER_IDをデフォルトユーザーとして使用
    const userId = process.env["LINE_USER_ID"] || "default";
    upsertUser(userId);

    // トークン全体をJSON文字列として保存（refresh_token含む）
    const tokenJson = JSON.stringify(tokens);
    updateUserTokens(userId, {
      gmailToken: tokenJson,
      gcalToken: tokenJson,
    });

    return c.html(`
      <h1>認証成功</h1>
      <p>Google連携が完了しました。このページを閉じてLINEに戻ってください。</p>
    `);
  } catch (err) {
    console.error("OAuth callback error:", err);
    return c.text("認証に失敗しました", 500);
  }
});

/**
 * DBからトークンを復元してOAuth2クライアントを返す。
 * 期限切れならrefreshし、新しいトークンをDBに書き戻す。
 */
export async function getAuthedClient(
  userId: string,
  tokenField: "gmailToken" | "gcalToken",
): Promise<InstanceType<typeof google.auth.OAuth2>> {
  console.log(`[auth] getAuthedClient: userId="${userId}" field="${tokenField}"`);
  const { getUser, updateUserTokens } = await import("../db/queries.js");
  const user = getUser(userId);
  if (!user) throw new Error(`User not found: ${userId}`);

  const raw = user[tokenField];
  if (!raw) throw new Error(`No ${tokenField} for user ${userId}. Run /auth/start first.`);

  const tokens = JSON.parse(raw);
  const oauth2Client = createOAuth2Client();
  oauth2Client.setCredentials(tokens);

  // 期限切れならrefresh
  const expiry = tokens.expiry_date as number | undefined;
  if (expiry && expiry < Date.now() + 60_000) {
    console.log("[auth] token expired, refreshing");
    const { credentials } = await oauth2Client.refreshAccessToken();
    oauth2Client.setCredentials(credentials);
    const updated = JSON.stringify(credentials);
    updateUserTokens(userId, { [tokenField]: updated } as {
      gmailToken?: string;
      gcalToken?: string;
    });
  }

  return oauth2Client;
}

export { auth, createOAuth2Client, SCOPES };
