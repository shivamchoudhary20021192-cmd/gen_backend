/**
 * Bootstraps the platform administrator.
 *
 *   npm run db:seed
 *
 * Creates (or resets) the identity in SUPERADMIN_EMAIL / SUPERADMIN_PASSWORD
 * with the platform `admin` role — the operator who can see every shop, change
 * plans and curate the app store at /platform/api/v1.
 *
 * If a store already exists (an upgraded single-shop installation, or
 * SEED_SHOP names one), the identity is also made a full-access member of it —
 * its owner when the store has none — so the same login opens that store's
 * admin. On a fresh platform with no stores, open the first one through
 * POST /platform/api/v1/signup or, signed in, POST /admin/api/v1/shops.
 *
 * Idempotent: running it again resets the password rather than duplicating.
 */
import bcrypt from 'bcryptjs';
import { env } from '../src/config/env';
import { closePool, controlPlane, execute, insert, queryOne, type RowDataPacket } from '../src/db/pool';
import { withTransaction } from '../src/db/transaction';

interface IdRow extends RowDataPacket {
  id: number;
}

async function main(): Promise<void> {
  const email = env.superAdmin.email.toLowerCase().trim();
  const password = env.superAdmin.password;

  if (password.length < 10) {
    throw new Error('SUPERADMIN_PASSWORD must be at least 10 characters.');
  }
  if (env.isProd && password === 'ChangeMe!2026') {
    throw new Error('Refusing to seed the default password in production. Set SUPERADMIN_PASSWORD.');
  }

  const passwordHash = await bcrypt.hash(password, env.auth.bcryptRounds);
  const existing = await queryOne<IdRow>('SELECT id FROM admin_users WHERE email = ? LIMIT 1', [email], controlPlane);

  const shopRef = process.env.SEED_SHOP?.trim().toLowerCase();
  const shop = await queryOne<IdRow & { handle: string; owner_user_id: number | null }>(
    shopRef
      ? 'SELECT id, handle, owner_user_id FROM shops WHERE handle = ? LIMIT 1'
      : "SELECT id, handle, owner_user_id FROM shops WHERE status <> 'closed' ORDER BY id LIMIT 1",
    shopRef ? [shopRef] : [],
    controlPlane,
  );
  if (shopRef && !shop) throw new Error(`SEED_SHOP=${shopRef} does not match any store.`);

  const adminId = await withTransaction(async (tx) => {
    let id: number;
    if (existing) {
      await execute(
        `UPDATE admin_users
            SET password_hash = ?, status = 'active', platform_role = 'admin', account_type = 'human',
                must_change_password = 0, failed_login_attempts = 0,
                locked_until = NULL, password_changed_at = NOW(), deleted_at = NULL
          WHERE id = ?`,
        [passwordHash, existing.id],
        tx,
      );
      id = existing.id;
    } else {
      id = await insert(
        `INSERT INTO admin_users
           (email, password_hash, first_name, last_name, status, is_super_admin, platform_role, account_type,
            must_change_password, password_changed_at, timezone)
         VALUES (?, ?, ?, ?, 'active', 0, 'admin', 'human', 0, NOW(), 'UTC')`,
        [email, passwordHash, env.superAdmin.firstName, env.superAdmin.lastName],
        tx,
      );
    }

    if (shop) {
      const owner = shop.owner_user_id === null || shop.owner_user_id === id;
      await execute(
        `INSERT INTO shop_staff (shop_id, admin_user_id, is_owner, has_full_access, status, joined_at)
         VALUES (?, ?, ?, 1, 'active', NOW())
         ON DUPLICATE KEY UPDATE has_full_access = 1, status = 'active'`,
        [shop.id, id, owner ? 1 : 0],
        tx,
      );
      if (owner && shop.owner_user_id === null) {
        await execute('UPDATE shops SET owner_user_id = ? WHERE id = ?', [id, shop.id], tx);
      }
    }

    // Platform-level: belongs to no shop, which is what a null shop_id means.
    await execute(
      `INSERT INTO audit_logs (shop_id, actor_type, actor_label, action, entity_type, entity_id, summary)
       VALUES (NULL, 'system', 'seed script', ?, 'admin_user', ?, ?)`,
      [existing ? 'admin_user.reset' : 'admin_user.created', id, `Seeded platform administrator ${email}`],
      tx,
    );
    return id;
  }, controlPlane);

  process.stdout.write(
    [
      '',
      '  Platform administrator ready',
      '  ─────────────────────────────────────────────',
      `  id       ${adminId}`,
      `  email    ${email}`,
      `  password ${env.isProd ? '(from SUPERADMIN_PASSWORD)' : password}`,
      `  action   ${existing ? 'updated existing account' : 'created new account'}`,
      `  store    ${shop ? `${shop.handle} (full access)` : 'none yet — open one with POST /platform/api/v1/signup'}`,
      '',
      '  Sign in:',
      `  POST /admin/api/v1/auth/login  { "email": "...", "password": "..." }`,
      '  Operator API: /platform/api/v1',
      '',
    ].join('\n'),
  );
}

main()
  .then(() => closePool())
  .then(() => process.exit(0))
  .catch(async (error) => {
    process.stderr.write(`\n  Seed failed: ${error instanceof Error ? error.message : String(error)}\n\n`);
    await closePool().catch(() => undefined);
    process.exit(1);
  });
