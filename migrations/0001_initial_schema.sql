-- DormLedger initial schema (Cloudflare D1 / SQLite). All money = integer toman.
PRAGMA foreign_keys = ON;

CREATE TABLE dormitories (
  id TEXT PRIMARY KEY, name TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND 80),
  currency TEXT NOT NULL DEFAULT 'IRT', created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE members (
  id TEXT PRIMARY KEY, dormitory_id TEXT NOT NULL REFERENCES dormitories(id),
  display_name TEXT NOT NULL CHECK (length(display_name) BETWEEN 1 AND 60),
  telegram_user_id INTEGER, role TEXT NOT NULL DEFAULT 'member' CHECK (role IN ('owner','admin','member')),
  active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0,1)), created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
-- one active member per Telegram account per dormitory
CREATE UNIQUE INDEX ux_members_tg_active ON members(dormitory_id, telegram_user_id) WHERE telegram_user_id IS NOT NULL AND active = 1;
CREATE INDEX ix_members_tg ON members(telegram_user_id);

CREATE TABLE invitations (
  id TEXT PRIMARY KEY, dormitory_id TEXT NOT NULL REFERENCES dormitories(id),
  member_id TEXT REFERENCES members(id), token_hash TEXT NOT NULL UNIQUE,
  expires_at TEXT NOT NULL, used_at TEXT, created_by TEXT NOT NULL REFERENCES members(id)
);
CREATE TABLE expense_categories (
  id TEXT PRIMARY KEY, dormitory_id TEXT NOT NULL REFERENCES dormitories(id), name TEXT NOT NULL,
  UNIQUE (dormitory_id, name)
);
CREATE TABLE expenses (
  id TEXT PRIMARY KEY, dormitory_id TEXT NOT NULL REFERENCES dormitories(id),
  description TEXT NOT NULL CHECK (length(description) BETWEEN 1 AND 200),
  category_id TEXT REFERENCES expense_categories(id),
  total_amount INTEGER NOT NULL CHECK (total_amount > 0),
  payer_id TEXT NOT NULL REFERENCES members(id), currency TEXT NOT NULL DEFAULT 'IRT',
  method TEXT NOT NULL CHECK (method IN ('equal','custom')),
  expense_date TEXT NOT NULL, notes TEXT, created_by TEXT NOT NULL REFERENCES members(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','cancelled')),
  version INTEGER NOT NULL DEFAULT 1, cancelled_by TEXT REFERENCES members(id), cancel_reason TEXT
);
CREATE INDEX ix_expenses_dorm_date ON expenses(dormitory_id, expense_date DESC);
CREATE TABLE expense_allocations (
  expense_id TEXT NOT NULL REFERENCES expenses(id), member_id TEXT NOT NULL REFERENCES members(id),
  amount INTEGER NOT NULL CHECK (amount > 0), PRIMARY KEY (expense_id, member_id)
);
CREATE INDEX ix_alloc_member ON expense_allocations(member_id);

CREATE TABLE settlements (
  id TEXT PRIMARY KEY, dormitory_id TEXT NOT NULL REFERENCES dormitories(id),
  from_member_id TEXT NOT NULL REFERENCES members(id), to_member_id TEXT NOT NULL REFERENCES members(id),
  amount INTEGER NOT NULL CHECK (amount > 0), settled_on TEXT NOT NULL, note TEXT,
  status TEXT NOT NULL DEFAULT 'confirmed' CHECK (status IN ('pending','confirmed','cancelled')),
  recorded_by TEXT NOT NULL REFERENCES members(id), created_at TEXT NOT NULL DEFAULT (datetime('now')),
  CHECK (from_member_id <> to_member_id)
);
CREATE INDEX ix_settle_dorm_status ON settlements(dormitory_id, status);
CREATE TABLE audit_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT, dormitory_id TEXT NOT NULL REFERENCES dormitories(id),
  actor_id TEXT, entity TEXT NOT NULL, entity_id TEXT NOT NULL, action TEXT NOT NULL,
  before_json TEXT, after_json TEXT, created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX ix_audit_entity ON audit_events(entity, entity_id, created_at);
CREATE TABLE idempotency_keys (
  key TEXT NOT NULL, dormitory_id TEXT NOT NULL, response_json TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')), PRIMARY KEY (dormitory_id, key)
);
CREATE TABLE settings (
  dormitory_id TEXT NOT NULL REFERENCES dormitories(id), key TEXT NOT NULL, value TEXT NOT NULL,
  PRIMARY KEY (dormitory_id, key)
);
