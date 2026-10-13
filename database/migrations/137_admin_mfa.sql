-- =============================================================================
-- 137 — Two-step sign-in for staff: TOTP from an authenticator app.
--
-- admin_users already carries the shape from the first schema (mfa_enabled,
-- mfa_secret sealed by the vault, mfa_recovery_codes as an array of hashes),
-- and admin_sessions.mfa_satisfied_at. Two columns are new:
--
--   mfa_last_used_step   The 30-second TOTP step of the last code accepted. A
--                        code is accepted only for a later step, in the same
--                        UPDATE that records it, so a code read over someone's
--                        shoulder cannot be replayed inside its window — and
--                        two requests racing with the same code cannot both
--                        win.
--   mfa_enabled_at       When the person turned it on, for the security page.
--
-- An admin with mfa_enabled = 1 but no secret (seeded rows, set before the
-- step existed) is not challenged: the setting was never something they
-- could satisfy. Enrolling sets both.
--
-- Idempotent: safe to run again.
-- =============================================================================

SET NAMES utf8mb4;

SET @ddl = IF(
  (SELECT COUNT(*) FROM information_schema.columns
    WHERE table_schema = DATABASE() AND table_name = 'admin_users' AND column_name = 'mfa_last_used_step') = 0,
  'ALTER TABLE `admin_users`
     ADD COLUMN `mfa_last_used_step` BIGINT UNSIGNED NULL AFTER `mfa_recovery_codes`,
     ADD COLUMN `mfa_enabled_at` DATETIME NULL AFTER `mfa_last_used_step`',
  'DO 0'
);
PREPARE `stmt137` FROM @ddl;
EXECUTE `stmt137`;
DEALLOCATE PREPARE `stmt137`;
