-- ╔══════════════════════════════════════════════════════════════╗
-- ║  SQLite スキーマ                                            ║
-- ║  PostgreSQL移行時の変更点は [PG] コメント参照                 ║
-- ╚══════════════════════════════════════════════════════════════╝

CREATE TABLE IF NOT EXISTS conversations (
  id          INTEGER PRIMARY KEY AUTOINCREMENT, -- [PG] SERIAL PRIMARY KEY
  user_id     TEXT NOT NULL,                     -- [PG] VARCHAR(255)
  role        TEXT NOT NULL CHECK(role IN ('user','assistant')), -- [PG] そのままOK
  content     TEXT NOT NULL,
  intent      TEXT,
  created_at  DATETIME DEFAULT CURRENT_TIMESTAMP -- [PG] TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS users (
  user_id             TEXT PRIMARY KEY,             -- [PG] VARCHAR(255) PRIMARY KEY
  display_name        TEXT,
  plan                TEXT DEFAULT 'trial',         -- 'trial','free','lite','standard','pro','expired' (CHECK制約はapp側で検証)
  trial_start_date    TEXT,                         -- [PG] TIMESTAMPTZ
  plan_expires_at     TEXT,                         -- [PG] TIMESTAMPTZ
  gmail_token         TEXT,                          -- [PG] JSONB推奨
  gcal_token          TEXT,                          -- [PG] JSONB推奨
  writing_style       TEXT,
  briefing_hour       INTEGER DEFAULT 8,             -- 0=通知しない / 7,8,9=その時刻に通知
  setup_stage         TEXT,                          -- NULL=未開始/完了, 'name','briefing','usecases'
  use_cases           TEXT,                          -- セットアップで選んだ主用途
  stripe_customer_id  TEXT,
  stripe_subscription_id TEXT,
  trial_reminders_sent TEXT,                         -- CSV of day markers 'd4,d6,d8'
  created_at          DATETIME DEFAULT CURRENT_TIMESTAMP, -- [PG] TIMESTAMPTZ DEFAULT NOW()
  updated_at          DATETIME DEFAULT CURRENT_TIMESTAMP  -- [PG] TIMESTAMPTZ DEFAULT NOW()
);

-- プロモコード（インフルエンサー等向け）
CREATE TABLE IF NOT EXISTS promo_codes (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  code             TEXT UNIQUE NOT NULL,              -- ユーザーが入力する文字列
  plan             TEXT NOT NULL,                     -- 'lite','standard','pro'
  duration_months  INTEGER NOT NULL,                  -- 付与する期間（月数）
  max_uses         INTEGER,                           -- NULL=無制限
  used_count       INTEGER NOT NULL DEFAULT 0,
  expires_at       TEXT,                              -- コード自体の有効期限（NULL=無期限）
  active           INTEGER NOT NULL DEFAULT 1,
  note             TEXT,                              -- 管理用メモ（例：〇〇さん向け）
  created_at       TEXT DEFAULT (datetime('now','localtime'))
);

-- プロモコード利用履歴
CREATE TABLE IF NOT EXISTS user_promos (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id           TEXT NOT NULL,
  code_id           INTEGER NOT NULL,
  plan              TEXT NOT NULL,
  redeemed_at       TEXT DEFAULT (datetime('now','localtime')),
  expires_at        TEXT NOT NULL,                    -- 付与プランの終了日時
  expiry_notified   INTEGER NOT NULL DEFAULT 0,       -- 7日前通知済みフラグ
  expired_notified  INTEGER NOT NULL DEFAULT 0        -- 終了通知済みフラグ
);

CREATE TABLE IF NOT EXISTS processed_emails (
  message_id   TEXT PRIMARY KEY,                 -- [PG] VARCHAR(255) PRIMARY KEY
  user_id      TEXT NOT NULL,
  category     TEXT DEFAULT 'fyi'
               CHECK(category IN ('urgent_reply','reply_later','action_needed','fyi','newsletter')),
  processed_at DATETIME DEFAULT CURRENT_TIMESTAMP -- [PG] TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS google_accounts (
  id          INTEGER PRIMARY KEY AUTOINCREMENT, -- [PG] SERIAL PRIMARY KEY
  user_id     TEXT NOT NULL,                     -- [PG] VARCHAR(255)
  label       TEXT NOT NULL DEFAULT 'default',
  email       TEXT,
  gmail_token TEXT,                               -- [PG] JSONB推奨
  gcal_token  TEXT,                               -- [PG] JSONB推奨
  created_at  DATETIME DEFAULT CURRENT_TIMESTAMP, -- [PG] TIMESTAMPTZ DEFAULT NOW()
  FOREIGN KEY (user_id) REFERENCES users(user_id),
  UNIQUE(user_id, label)                         -- [PG] そのままOK
);

CREATE TABLE IF NOT EXISTS usage_logs (
  id          INTEGER PRIMARY KEY AUTOINCREMENT, -- [PG] SERIAL PRIMARY KEY
  user_id     TEXT NOT NULL,
  action_type TEXT NOT NULL,
  created_at  TEXT DEFAULT (datetime('now','localtime'))
);

CREATE INDEX IF NOT EXISTS idx_usage_logs_user_month
  ON usage_logs (user_id, action_type, created_at);

CREATE TABLE IF NOT EXISTS pending_replies (
  id               INTEGER PRIMARY KEY AUTOINCREMENT, -- [PG] SERIAL PRIMARY KEY
  user_id          TEXT NOT NULL,
  thread_id        TEXT NOT NULL,
  to_address       TEXT NOT NULL,
  subject          TEXT NOT NULL,
  draft_content    TEXT NOT NULL,
  status           TEXT DEFAULT 'pending'
                   CHECK(status IN ('pending','hold','sent','cancelled','modified')),
  created_at       DATETIME DEFAULT CURRENT_TIMESTAMP, -- [PG] TIMESTAMPTZ DEFAULT NOW()
  sent_at          DATETIME                            -- [PG] TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS monthly_send_count (
  user_id     TEXT NOT NULL,
  year_month  TEXT NOT NULL,              -- 例: '2026-04'
  count       INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (user_id, year_month)
);

CREATE TABLE IF NOT EXISTS timers (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  line_user_id  TEXT NOT NULL,
  fire_at       TEXT NOT NULL,
  message       TEXT NOT NULL,
  done          INTEGER DEFAULT 0,
  created_at    TEXT DEFAULT (datetime('now','localtime'))
);

CREATE TABLE IF NOT EXISTS briefing_items (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  line_user_id  TEXT NOT NULL,
  number        INTEGER NOT NULL,
  email_id      TEXT NOT NULL,
  thread_id     TEXT NOT NULL,
  type          TEXT NOT NULL CHECK(type IN ('reply_needed','followup','fyi')),
  summary       TEXT NOT NULL,
  created_at    TEXT DEFAULT (datetime('now','localtime'))
);

CREATE TABLE IF NOT EXISTS email_cache (
  message_id  TEXT NOT NULL,
  user_id     TEXT NOT NULL,
  category    TEXT NOT NULL,
  cached_at   TEXT DEFAULT (datetime('now', 'localtime')),
  PRIMARY KEY (message_id, user_id)
);

CREATE TABLE IF NOT EXISTS email_watch_rules (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id       TEXT NOT NULL,
  match_type    TEXT NOT NULL CHECK(match_type IN ('from','subject','keyword','from_and_keyword')),
  pattern       TEXT NOT NULL,
  pattern2      TEXT,
  description   TEXT NOT NULL,
  active        INTEGER DEFAULT 1,
  created_at    TEXT DEFAULT (datetime('now','localtime'))
);

CREATE TABLE IF NOT EXISTS email_watch_notified (
  rule_id       INTEGER NOT NULL,
  message_id    TEXT NOT NULL,
  notified_at   TEXT DEFAULT (datetime('now','localtime')),
  PRIMARY KEY (rule_id, message_id)
);
