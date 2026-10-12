-- Bot conversation state and webhook de-duplication.
CREATE TABLE bot_state (
  telegram_user_id INTEGER PRIMARY KEY, state TEXT NOT NULL, updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE processed_updates (
  update_id INTEGER PRIMARY KEY, created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
