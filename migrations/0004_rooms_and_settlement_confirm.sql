ALTER TABLE dormitories ADD COLUMN deleted_at TEXT;
ALTER TABLE settlements ADD COLUMN confirmed_by TEXT;
ALTER TABLE settlements ADD COLUMN confirmed_at TEXT;
CREATE TABLE user_prefs (telegram_user_id INTEGER PRIMARY KEY, dormitory_id TEXT);
