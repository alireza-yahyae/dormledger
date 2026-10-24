-- "عدل‌بدل" (substitute) members: people who are NOT ticked by default when an expense is added.
-- 0 = main member (default, ticked by default), 1 = substitute (unticked by default; whoever records the expense can still tick them).
-- Only changes the default selection: balances and existing expenses are untouched.
ALTER TABLE members ADD COLUMN is_substitute INTEGER NOT NULL DEFAULT 0 CHECK (is_substitute IN (0,1));
