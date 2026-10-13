-- ─────────────────────────────────────────────────────────────────────────────
-- Document numbering, as a counter rather than a MAX().
--
-- Order numbers were derived from `SELECT MAX(order_number) FROM orders`, which
-- is a string comparison: once any row carried a non-numeric number — a legacy
-- import, a test fixture like 'VEYRTTVLZD' — MAX returned that row, stripping
-- its digits produced 0, and every subsequent checkout tried to write
-- VEY0000001 again and hit the unique index. Checkout stayed broken until
-- someone deleted the offending row.
--
-- MAX() is also not safe under concurrency: two checkouts in the same
-- millisecond read the same MAX and one of them loses.
--
-- This table is the fix. `UPDATE ... SET current_value = LAST_INSERT_ID(...)`
-- takes a row lock and hands back the incremented value in one statement, so
-- two concurrent callers are serialised by InnoDB and can never be issued the
-- same number.
--
-- Idempotent: safe to run more than once.
-- ─────────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS number_sequences (
  name           VARCHAR(40)     NOT NULL,
  prefix         VARCHAR(10)     NOT NULL DEFAULT '',
  -- The last value handed out. The next caller receives current_value + 1.
  current_value  BIGINT UNSIGNED NOT NULL DEFAULT 0,
  padding        TINYINT UNSIGNED NOT NULL DEFAULT 7,
  updated_at     DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (name)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

INSERT IGNORE INTO number_sequences (name, prefix, current_value, padding)
VALUES
  ('order',  'VEY', 0, 7),
  ('return', 'RET', 0, 7),
  ('invoice','INV', 0, 7);

-- Start the counter above whatever numeric order numbers already exist, so a
-- database with real orders in it does not immediately collide. Rows whose
-- number is not of the form <prefix><digits> are ignored on purpose: they are
-- exactly the rows that broke the old scheme.
UPDATE number_sequences s
   SET s.current_value = GREATEST(
     s.current_value,
     COALESCE((
       SELECT MAX(CAST(SUBSTRING(o.order_number, CHAR_LENGTH(s.prefix) + 1) AS UNSIGNED))
         FROM orders o
        WHERE o.order_number REGEXP CONCAT('^', s.prefix, '[0-9]+$')
     ), 0)
   )
 WHERE s.name = 'order';
