-- "Clear history" moves a room's expenses/settlements into archive tables for 48 hours so it can be restored.
CREATE TABLE archives (
  id TEXT PRIMARY KEY, dormitory_id TEXT NOT NULL REFERENCES dormitories(id), created_by TEXT,
  created_at TEXT NOT NULL, expires_at TEXT NOT NULL, n_expenses INTEGER NOT NULL, n_settlements INTEGER NOT NULL
);
CREATE INDEX ix_archives_dorm ON archives(dormitory_id, expires_at);
CREATE TABLE archived_expenses AS SELECT * FROM expenses WHERE 0;
ALTER TABLE archived_expenses ADD COLUMN archive_id TEXT;
CREATE TABLE archived_allocations AS SELECT * FROM expense_allocations WHERE 0;
ALTER TABLE archived_allocations ADD COLUMN archive_id TEXT;
CREATE TABLE archived_settlements AS SELECT * FROM settlements WHERE 0;
ALTER TABLE archived_settlements ADD COLUMN archive_id TEXT;
CREATE INDEX ix_arch_exp ON archived_expenses(archive_id);
CREATE INDEX ix_arch_alloc ON archived_allocations(archive_id);
CREATE INDEX ix_arch_set ON archived_settlements(archive_id);
