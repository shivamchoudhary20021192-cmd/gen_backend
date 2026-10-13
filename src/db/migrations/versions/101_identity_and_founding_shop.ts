import crypto from 'node:crypto';
import type { RowDataPacket } from 'mysql2/promise';
import { addColumnIfMissing, indexExists, rows, scalar, tableExists } from '../helpers';
import type { MigrationContext, TsMigration } from '../runner';

/**
 * Turns the single-shop installation into shop #1 of a platform.
 *
 * Before this, "the shop" was implicit: every row belonged to it because there
 * was nothing else to belong to. After this, it is an explicit `shops` row with
 * an owner, staff, a domain and a subscription — built from what the database
 * already says about the store rather than from constants, so the Veylor
 * installation keeps its name, currency and people.
 *
 * Also splits identity from authority on admin_users:
 *   platform_role  what the person may do to the PLATFORM (none/support/admin)
 *   account_type   human, or a bot identity an installed app acts as
 * Authority inside a shop moves to shop_staff (table 100).
 *
 * Idempotent: every step checks before it writes.
 */

const FOUNDING_SHOP_ID = 1;

function slugHandle(name: string): string {
  const handle = name
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60)
    .replace(/-+$/g, '');
  return handle || 'main';
}

function hostnameOf(url: string | undefined): string | null {
  if (!url) return null;
  try {
    const host = new URL(url).hostname.toLowerCase();
    // Local development hosts are not domains anyone can verify or route.
    if (host === 'localhost' || host.endsWith('.localhost') || /^[\d.]+$/.test(host) || host.includes(':')) return null;
    return host;
  } catch {
    return null;
  }
}

async function setting(ctx: MigrationContext, key: string): Promise<string | null> {
  if (!(await tableExists(ctx, 'settings'))) return null;
  const value = await scalar<string>(ctx, 'SELECT value FROM settings WHERE setting_key = ? LIMIT 1', [key]);
  return value && String(value).trim() !== '' ? String(value).trim() : null;
}

const migration: TsMigration = {
  description: 'Identity/authority split and the founding shop',

  async up(ctx) {
    await addColumnIfMissing(
      ctx,
      'admin_users',
      'platform_role',
      "ENUM('none','support','admin') NOT NULL DEFAULT 'none' AFTER `is_super_admin`",
    );
    await addColumnIfMissing(
      ctx,
      'admin_users',
      'account_type',
      "ENUM('human','app','system') NOT NULL DEFAULT 'human' AFTER `platform_role`",
    );
    await addColumnIfMissing(ctx, 'admin_sessions', 'active_shop_id', 'BIGINT UNSIGNED NULL AFTER `admin_user_id`');
    if (!(await indexExists(ctx, 'admin_sessions', 'ix_admin_sessions_active_shop'))) {
      await ctx.exec('ALTER TABLE `admin_sessions` ADD KEY `ix_admin_sessions_active_shop` (`active_shop_id`)');
    }

    // Everyone who could do everything in the one shop could also, in effect,
    // run the installation. That stays true for them and only for them.
    await ctx.exec(
      "UPDATE admin_users SET platform_role = 'admin' WHERE is_super_admin = 1 AND platform_role = 'none' AND deleted_at IS NULL",
    );

    const existing = Number(await scalar(ctx, 'SELECT COUNT(*) FROM shops WHERE id = ?', [FOUNDING_SHOP_ID]));
    if (existing > 0) {
      ctx.log('founding shop already exists');
    } else {
      const name = (await setting(ctx, 'store.name')) ?? 'My Store';
      const legalName = (await setting(ctx, 'store.legal_name')) ?? (await setting(ctx, 'seller_legal_name')) ?? name;
      const currency = ((await setting(ctx, 'store.currency')) ?? 'INR').toUpperCase().slice(0, 3);
      const timezone = (await setting(ctx, 'store.timezone')) ?? 'Asia/Kolkata';
      const email = await setting(ctx, 'store.support_email');
      const phone = await setting(ctx, 'store.support_phone');
      const owner = await scalar<number>(
        ctx,
        'SELECT id FROM admin_users WHERE is_super_admin = 1 AND deleted_at IS NULL ORDER BY id LIMIT 1',
      );
      const handle = slugHandle(name);

      const orgPublicId = crypto.randomUUID();
      await ctx.exec(
        'INSERT INTO organizations (public_id, name, owner_user_id, billing_email, country_code) VALUES (?, ?, ?, ?, ?)',
        [orgPublicId, legalName, owner, email, 'IN'],
      );
      const organizationId = ctx.dryRun
        ? 0
        : await scalar<number>(ctx, 'SELECT id FROM organizations WHERE public_id = ?', [orgPublicId]);

      const planId = await scalar<number>(ctx, "SELECT id FROM plans WHERE handle = 'enterprise'");

      await ctx.exec(
        `INSERT INTO shops
           (id, public_id, handle, name, email, phone, organization_id, owner_user_id, pod_id, plan_id,
            status, vertical, country_code, currency, timezone, locale, tax_engine, provisioned_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, ?, 'active', 'beauty', 'IN', ?, ?, 'en', 'in_gst', NOW())`,
        [FOUNDING_SHOP_ID, crypto.randomUUID(), handle, name, email, phone, organizationId, owner, planId, currency, timezone],
      );

      if (planId) {
        // The founding shop is the operator's own store: never billed, never
        // frozen for non-payment.
        await ctx.exec(
          `INSERT INTO shop_subscriptions
             (shop_id, plan_id, status, price_amount, currency, current_period_start, current_period_end, provider)
           VALUES (?, ?, 'active', 0, ?, NOW(), DATE_ADD(NOW(), INTERVAL 100 YEAR), 'internal')`,
          [FOUNDING_SHOP_ID, planId, currency],
        );
      }

      const platformDomain = (process.env.PLATFORM_STOREFRONT_DOMAIN ?? 'myveylog.com').toLowerCase();
      const customHost = hostnameOf(process.env.STOREFRONT_URL);
      await ctx.exec(
        `INSERT INTO shop_domains (shop_id, hostname, kind, is_primary, verification_status, verification_token, verified_at, ssl_status)
         VALUES (?, ?, 'platform', ?, 'verified', ?, NOW(), 'active')`,
        [FOUNDING_SHOP_ID, `${handle}.${platformDomain}`, customHost ? 0 : 1, crypto.randomBytes(16).toString('hex')],
      );
      if (customHost) {
        // The domain the store already serves from. It was in production
        // before verification existed, so it is grandfathered as verified.
        await ctx.exec(
          `INSERT INTO shop_domains (shop_id, hostname, kind, is_primary, verification_status, verification_token, verified_at, ssl_status)
           VALUES (?, ?, 'custom', 1, 'verified', ?, NOW(), 'active')`,
          [FOUNDING_SHOP_ID, customHost, crypto.randomBytes(16).toString('hex')],
        );
      }

      ctx.log(`founding shop #${FOUNDING_SHOP_ID} "${name}" (${handle}) created`);
    }

    // Every existing staff account becomes staff of the founding shop, with the
    // authority it had: super admins keep full access, the first one owns it.
    const owner = await scalar<number>(ctx, 'SELECT owner_user_id FROM shops WHERE id = ?', [FOUNDING_SHOP_ID]);
    const staff = await rows<RowDataPacket>(
      ctx,
      `SELECT a.id, a.is_super_admin, a.status, a.job_title, a.created_at
         FROM admin_users a
         LEFT JOIN shop_staff s ON s.admin_user_id = a.id AND s.shop_id = ?
        WHERE a.deleted_at IS NULL AND a.account_type = 'human' AND s.id IS NULL`,
      [FOUNDING_SHOP_ID],
    );
    for (const person of staff) {
      const status = person.status === 'active' ? 'active' : person.status === 'invited' ? 'invited' : 'suspended';
      const isOwner = owner !== null && Number(person.id) === Number(owner) ? 1 : 0;
      await ctx.exec(
        `INSERT INTO shop_staff (shop_id, admin_user_id, is_owner, has_full_access, status, job_title, joined_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [FOUNDING_SHOP_ID, person.id, isOwner, person.is_super_admin ? 1 : isOwner, status, person.job_title, person.created_at],
      );
    }
    if (staff.length > 0) ctx.log(`${staff.length} staff account(s) joined the founding shop`);

    await ctx.exec('UPDATE admin_sessions SET active_shop_id = ? WHERE active_shop_id IS NULL', [FOUNDING_SHOP_ID]);
  },
};

export default migration;
