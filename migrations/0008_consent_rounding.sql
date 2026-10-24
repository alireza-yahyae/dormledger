-- A15: adding someone by Telegram ID now needs their consent. The request is pending until they tap "accept" in the bot.
CREATE TABLE member_requests (
  id TEXT PRIMARY KEY,
  dormitory_id TEXT NOT NULL REFERENCES dormitories(id),
  telegram_user_id INTEGER NOT NULL,
  name TEXT NOT NULL DEFAULT '',
  created_by TEXT NOT NULL REFERENCES members(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  expires_at TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','accepted','declined','cancelled'))
);
CREATE INDEX ix_member_requests_tg ON member_requests(telegram_user_id, status);
CREATE UNIQUE INDEX ux_member_requests_pending ON member_requests(dormitory_id, telegram_user_id) WHERE status = 'pending';

-- C5: optional rounding of suggested transfers. 0 = exact; otherwise the unit in hundredths of a toman (100000 = 1000 toman).
ALTER TABLE dormitories ADD COLUMN round_to INTEGER NOT NULL DEFAULT 0;
