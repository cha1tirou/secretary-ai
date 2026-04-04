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
  user_id          TEXT PRIMARY KEY,             -- [PG] VARCHAR(255) PRIMARY KEY
  display_name     TEXT,
  plan             TEXT DEFAULT 'trial'         -- [PG] VARCHAR(20) DEFAULT 'trial'
                   CHECK(plan IN ('trial','light','pro','expired')),
  trial_start_date TEXT,                        -- [PG] TIMESTAMPTZ
  plan_expires_at  TEXT,                        -- [PG] TIMESTAMPTZ
  gmail_token      TEXT,                         -- [PG] JSONB推奨
  gcal_token       TEXT,                         -- [PG] JSONB推奨
  writing_style    TEXT,
  briefing_hour    INTEGER DEFAULT 8,
  created_at       DATETIME DEFAULT CURRENT_TIMESTAMP, -- [PG] TIMESTAMPTZ DEFAULT NOW()
  updated_at       DATETIME DEFAULT CURRENT_TIMESTAMP  -- [PG] TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS processed_emails (
  message_id   TEXT PRIMARY KEY,                 -- [PG] VARCHAR(255) PRIMARY KEY
  user_id      TEXT NOT NULL,
  category     TEXT DEFAULT 'other'
               CHECK(category IN ('reply_urgent','reply_later','important_info','newsletter','other')),
  processed_at DATETIME DEFAULT CURRENT_TIMESTAMP -- [PG] TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS tasks (
  id          INTEGER PRIMARY KEY AUTOINCREMENT, -- [PG] SERIAL PRIMARY KEY
  user_id     TEXT NOT NULL,
  title       TEXT NOT NULL,
  description TEXT,
  due_date    TEXT,                               -- [PG] DATE
  source      TEXT DEFAULT 'manual',
  source_id   TEXT,
  status      TEXT DEFAULT 'todo'
              CHECK(status IN ('todo','done','cancelled')),
  notified_at TEXT,                               -- [PG] TIMESTAMPTZ
  created_at  TEXT DEFAULT (datetime('now','localtime')) -- [PG] TIMESTAMPTZ DEFAULT NOW()
);

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
