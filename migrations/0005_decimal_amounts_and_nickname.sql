-- Amounts are now stored in hundredths of a toman (2 decimal places). Existing integer-toman rows are scaled x100.
UPDATE expenses SET total_amount = total_amount * 100;
UPDATE expense_allocations SET amount = amount * 100;
UPDATE settlements SET amount = amount * 100;
-- Optional nickname per member.
ALTER TABLE members ADD COLUMN nickname TEXT;
