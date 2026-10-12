-- Room option: must the creditor confirm a "I paid my share" record? 1 = yes (default, previous behaviour), 0 = recorded immediately.
ALTER TABLE dormitories ADD COLUMN require_confirm INTEGER NOT NULL DEFAULT 1;
