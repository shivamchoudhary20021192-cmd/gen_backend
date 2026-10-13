import { planPriceFor } from '../billing/billingEngine';
import { billingProvider } from '../billing/providers';
import { randomBytes, randomUUID } from 'node:crypto';
import { env } from '../../config/env';
import { ApiError } from '../../core/ApiError';
import { logger } from '../../core/logger';
import { controlPlane, execute, insert, query, queryOne, type Executor, type RowDataPacket } from '../../db/pool';
import { withTransaction } from '../../db/transaction';
import { jobQueue } from '../jobs/queue';
import { defineJob, PermanentJobError } from '../jobs/registry';
import { metrics } from '../observability/metrics';
import { themesService } from '../themes/themes.service';
import { shopId, tenancy, type ShopContext } from '../tenancy/context';
import {
  BASE_FAQ_GROUPS,
  BASE_MEDIA_FOLDERS,
  BASE_MENUS,
  BASE_ROLES,
  BASE_TEMPLATES,
  ONBOARDING_TASKS,
  segments,
  sequences,
  settings,
} from './blueprints/base';
import { regionFor } from './blueprints/regions';
import type { CategorySeed, ProvisionInput, RegionProfile, VerticalBlueprint } from './blueprints/types';
import { VERTICAL_KEYS, verticalFor } from './blueprints/verticals';
import { shopDirectory } from './shopDirectory';
import { shopsRepository } from './shops.repository';

/**
 * Creating a shop.
 *
 * Two phases, because they live in different databases:
 *
 *   1. Control plane, one transaction: the organisation, the shop row
 *      (status `provisioning`), its platform domain, its trial subscription
 *      and its owner. After this the shop exists and has an owner, but no
 *      tenant data.
 *
 *   2. The shop's pod: a list of steps that seed it from its blueprints —
 *      roles, settings, taxonomy, catalogue skeleton, tax, shipping,
 *      templates, content, theme. Every step is idempotent (INSERT IGNORE
 *      against the tenant unique keys, or an existence check) and recorded
 *      in shop_setup_tasks when it completes, so a run that dies halfway
 *      resumes from the step that failed. When the last step is done the
 *      shop becomes `active`.
 *
 * Phase 2 runs inline so a merchant who signs up lands in a working admin a
 * second later; if it fails, the `shops.provision` job retries it with backoff
 * and the admin shows "setting up your store" until it succeeds.
 */

export interface CreateShopInput {
  name: string;
  handle?: string | null;
  vertical?: string | null;
  countryCode: string;
  currency?: string | null;
  timezone?: string | null;
  locale?: string | null;
  email?: string | null;
  phone?: string | null;
  plan?: string | null;
  /** The theme the merchant picked while signing up (a theme store handle), and its style. */
  theme?: string | null;
  themeStyle?: string | null;
  /** What they told onboarding: how far along they are, where they will sell. */
  onboarding?: { stage: string | null; channels: string[] } | null;
}

interface StepContext {
  shop: ShopContext;
  input: ProvisionInput;
  region: RegionProfile;
  vertical: VerticalBlueprint;
}

interface Step {
  key: string;
  run(context: StepContext, tx: Executor): Promise<void>;
}

const RESERVED_HANDLES = new Set([
  'www', 'admin', 'api', 'app', 'apps', 'shop', 'shops', 'store', 'stores', 'platform', 'help', 'support', 'status',
  'mail', 'email', 'cdn', 'static', 'assets', 'media', 'blog', 'docs', 'billing', 'account', 'accounts', 'login',
  'signup', 'oauth', 'webhooks', 'integrations', 'partners', 'dev', 'staging', 'test', 'root', 'system',
]);

function slugify(value: string): string {
  return value
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 50)
    .replace(/-+$/g, '');
}

export function validHandle(handle: string): boolean {
  return /^[a-z0-9]([a-z0-9-]{0,58}[a-z0-9])?$/.test(handle) && !RESERVED_HANDLES.has(handle);
}

// ── the steps ────────────────────────────────────────────────────────────────

async function insertCategoryTree(nodes: CategorySeed[], parent: { id: number; path: string; depth: number } | null, tx: Executor) {
  for (const [index, node] of nodes.entries()) {
    const slug = parent ? `${parent.path.split('/').pop()}-${node.slug}` : node.slug;
    const path = parent ? `${parent.path}/${slug}` : slug;
    await execute(
      `INSERT IGNORE INTO categories (shop_id, parent_id, slug, name, short_description, path, depth, sort_order, is_active, show_in_menu)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, ?)`,
      [shopId(), parent?.id ?? null, slug, node.name, node.description ?? null, path, parent ? parent.depth + 1 : 0, index * 10, parent ? 0 : 1],
      tx,
    );
    const row = await queryOne<RowDataPacket & { id: number }>('SELECT id FROM categories WHERE shop_id = ? AND slug = ?', [shopId(), slug], tx);
    if (row && node.children?.length) {
      await insertCategoryTree(node.children, { id: Number(row.id), path, depth: parent ? parent.depth + 1 : 0 }, tx);
    }
  }
}

const STEPS: Step[] = [
  {
    key: 'roles',
    async run(_context, tx) {
      const permissions = await query<RowDataPacket & { id: number; slug: string }>('SELECT id, slug FROM permissions', [], controlPlane);
      const bySlug = new Map(permissions.map((permission) => [permission.slug, Number(permission.id)]));
      for (const role of BASE_ROLES) {
        await execute(
          'INSERT IGNORE INTO roles (shop_id, slug, name, description, is_system, level) VALUES (?, ?, ?, ?, 1, ?)',
          [shopId(), role.slug, role.name, role.description, role.level],
          tx,
        );
        const row = await queryOne<RowDataPacket & { id: number }>('SELECT id FROM roles WHERE shop_id = ? AND slug = ?', [shopId(), role.slug], tx);
        if (!row) continue;
        const ids = role.permissions === '*' ? [...bySlug.values()] : role.permissions.map((slug) => bySlug.get(slug)).filter((id): id is number => id !== undefined);
        if (ids.length === 0) continue;
        await execute(
          `INSERT IGNORE INTO role_permissions (shop_id, role_id, permission_id) VALUES ${ids.map(() => '(?, ?, ?)').join(', ')}`,
          ids.flatMap((permissionId) => [shopId(), Number(row.id), permissionId]),
          tx,
        );
      }
    },
  },
  {
    key: 'settings',
    async run({ input, region }, tx) {
      for (const setting of settings(input, region)) {
        await execute(
          `INSERT IGNORE INTO settings
             (shop_id, group_key, setting_key, label, value, default_value, value_type, description, is_public, sort_order)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            shopId(),
            setting.group,
            setting.key,
            setting.label,
            setting.value,
            setting.defaultValue ?? null,
            setting.type,
            setting.description ?? null,
            setting.isPublic ? 1 : 0,
            setting.sortOrder ?? 0,
          ],
          tx,
        );
      }
      for (const sequence of sequences(input)) {
        await execute(
          'INSERT IGNORE INTO number_sequences (shop_id, name, prefix, current_value, padding) VALUES (?, ?, ?, 0, ?)',
          [shopId(), sequence.name, sequence.prefix, sequence.padding],
          tx,
        );
      }
    },
  },
  {
    key: 'taxonomy',
    async run({ vertical }, tx) {
      for (const [index, lookup] of vertical.lookups.entries()) {
        await execute(
          `INSERT IGNORE INTO lookup_categories (shop_id, code, name, description, is_active, allow_custom, sort_order)
           VALUES (?, ?, ?, ?, 1, ?, ?)`,
          [shopId(), lookup.code, lookup.name, lookup.description ?? null, lookup.allowCustom ? 1 : 0, index + 1],
          tx,
        );
        const row = await queryOne<RowDataPacket & { id: number }>('SELECT id FROM lookup_categories WHERE shop_id = ? AND code = ?', [
          shopId(),
          lookup.code,
        ], tx);
        if (!row || lookup.values.length === 0) continue;
        await execute(
          `INSERT IGNORE INTO lookup_values (shop_id, category_id, code, label, is_active, sort_order)
           VALUES ${lookup.values.map(() => '(?, ?, ?, ?, 1, ?)').join(', ')}`,
          lookup.values.flatMap((value, valueIndex) => [shopId(), Number(row.id), value.code, value.label, valueIndex + 1]),
          tx,
        );
      }
      for (const [index, field] of vertical.metafields.entries()) {
        await execute(
          `INSERT IGNORE INTO metafield_definitions
             (shop_id, owner_type, namespace, meta_key, name, description, value_type, is_public, is_filterable, sort_order)
           VALUES (?, ?, 'custom', ?, ?, ?, ?, 1, ?, ?)`,
          [shopId(), field.ownerType, field.key, field.name, field.description ?? null, field.type, field.filterable ? 1 : 0, index + 1],
          tx,
        );
      }
      for (const synonym of vertical.searchSynonyms) {
        await execute(
          "INSERT IGNORE INTO search_synonyms (shop_id, term, synonyms, match_type, is_active) VALUES (?, ?, ?, 'synonym', 1)",
          [shopId(), synonym.term, synonym.synonyms.join(', ')],
          tx,
        );
      }
    },
  },
  {
    key: 'catalog',
    async run({ vertical }, tx) {
      await insertCategoryTree(vertical.categories, null, tx);
      for (const [index, collection] of vertical.collections.entries()) {
        await execute(
          `INSERT IGNORE INTO collections
             (shop_id, slug, title, subtitle, collection_type, sort_type, is_active, show_in_menu, published_at, sort_order)
           VALUES (?, ?, ?, ?, 'manual', ?, 1, ?, NOW(), ?)`,
          [shopId(), collection.slug, collection.title, collection.subtitle ?? null, collection.sortType, collection.showInMenu ? 1 : 0, index * 10],
          tx,
        );
      }
    },
  },
  {
    key: 'commerce',
    async run({ input, region }, tx) {
      for (const taxClass of region.taxClasses) {
        await execute(
          `INSERT IGNORE INTO tax_classes (shop_id, code, name, hsn_code, gst_rate, cess_rate, is_inclusive, is_exempt, is_default, is_active)
           VALUES (?, ?, ?, ?, ?, 0, ?, ?, ?, 1)`,
          [
            shopId(),
            taxClass.code,
            taxClass.name,
            taxClass.hsnCode ?? null,
            taxClass.rate,
            taxClass.inclusive ? 1 : 0,
            // A zero-rate class is the exempt one: it matters where the rate
            // comes from the destination, not the class.
            taxClass.rate === 0 && !taxClass.isDefault ? 1 : 0,
            taxClass.isDefault ? 1 : 0,
          ],
          tx,
        );
      }

      await execute(
        `INSERT IGNORE INTO inventory_locations
           (shop_id, code, name, location_type, country, contact_phone, is_default, is_active, fulfils_online_orders, priority)
         VALUES (?, 'PRIMARY', 'Primary location', 'warehouse', ?, ?, 1, 1, 1, 0)`,
        [shopId(), input.countryCode, input.phone],
        tx,
      );

      // The primary market: the store's own country, in its own currency.
      const primary = await insert(
        'INSERT IGNORE INTO markets (shop_id, name, currency, is_primary) VALUES (?, ?, ?, 1)',
        [shopId(), `Domestic (${input.countryCode})`, input.currency],
        tx,
      );
      if (primary) {
        await execute('INSERT IGNORE INTO market_countries (shop_id, market_id, country_code) VALUES (?, ?, ?)', [shopId(), primary, input.countryCode], tx);
      }

      const existingRates = await queryOne<RowDataPacket & { total: number }>('SELECT COUNT(*) AS total FROM shipping_rates WHERE shop_id = ?', [shopId()], tx);
      if (Number(existingRates?.total ?? 0) === 0) {
        for (const rate of region.shippingRates) {
          await execute(
            `INSERT INTO shipping_rates
               (shop_id, name, zone, method, min_order_amount, rate, free_above_amount, eta_min_days, eta_max_days, is_active, priority)
             VALUES (?, ?, 'all', ?, 0, ?, ?, ?, ?, 1, ?)`,
            [shopId(), rate.name, rate.method, rate.rate, rate.freeAbove, rate.etaMinDays, rate.etaMaxDays, rate.priority],
            tx,
          );
        }
        for (const zone of region.shippingZones ?? []) {
          const zoneId = await insert('INSERT INTO shipping_zones (shop_id, name) VALUES (?, ?)', [shopId(), zone.name], tx);
          const places = [
            ...(zone.regions ?? []).map((code) => ({ region: code, prefix: null })),
            ...(zone.postalPrefixes ?? []).map((prefix) => ({ region: null, prefix })),
          ];
          for (const place of places) {
            await execute(
              'INSERT INTO shipping_zone_areas (shop_id, zone_id, country_code, region_code, postal_prefix) VALUES (?, ?, ?, ?, ?)',
              [shopId(), zoneId, input.countryCode, place.region, place.prefix],
              tx,
            );
          }
          for (const rate of zone.rates) {
            await execute(
              `INSERT INTO shipping_rates
                 (shop_id, name, zone, zone_id, method, min_order_amount, rate, free_above_amount, eta_min_days, eta_max_days, is_active, priority)
               VALUES (?, ?, 'all', ?, ?, 0, ?, ?, ?, ?, 1, ?)`,
              [shopId(), rate.name, zoneId, rate.method, rate.rate, rate.freeAbove, rate.etaMinDays, rate.etaMaxDays, rate.priority],
              tx,
            );
          }
        }
      }

      for (const carrier of region.carriers) {
        await execute(
          `INSERT IGNORE INTO shipping_carriers
             (shop_id, code, name, tracking_url_template, api_provider, supports_cod, supports_reverse_pickup, is_active, priority)
           VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?)`,
          [shopId(), carrier.code, carrier.name, carrier.trackingUrlTemplate, carrier.apiProvider, carrier.supportsCod ? 1 : 0, carrier.supportsReversePickup ? 1 : 0, carrier.priority],
          tx,
        );
      }

      if (region.cod) {
        const existingCod = await queryOne<RowDataPacket & { total: number }>('SELECT COUNT(*) AS total FROM cod_rules WHERE shop_id = ?', [shopId()], tx);
        if (Number(existingCod?.total ?? 0) === 0) {
          await execute(
            `INSERT INTO cod_rules
               (shop_id, name, is_active, min_order_amount, max_order_amount, cod_fee, prepaid_discount_amount, requires_otp_confirmation, max_open_cod_orders, priority)
             VALUES (?, ?, 1, ?, ?, ?, ?, ?, 2, 0)`,
            [shopId(), region.cod.name, region.cod.minOrder, region.cod.maxOrder, region.cod.fee, region.cod.prepaidDiscount, region.cod.requiresOtp ? 1 : 0],
            tx,
          );
        }
      }
    },
  },
  {
    key: 'messaging',
    async run({ input, region }, tx) {
      for (const template of BASE_TEMPLATES) {
        await execute(
          `INSERT IGNORE INTO notification_templates
             (shop_id, event_key, channel, category, locale, name, subject, body, is_transactional, is_active)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1)`,
          [
            shopId(),
            template.eventKey,
            template.channel,
            template.category,
            'en-IN',
            template.name,
            template.subject ?? null,
            template.body,
            template.category === 'marketing' ? 0 : 1,
          ],
          tx,
        );
      }
      const header = input.handle.replace(/[^a-z]/gi, '').toUpperCase().slice(0, 6).padEnd(6, 'X');
      const senders: [string, string, Record<string, unknown>][] = [
        ['email', `${input.shopName} (default)`, { from_name: input.shopName, from_email: input.email }],
        ['sms', `${header} (default)`, { sms_header: header }],
        ['whatsapp', `${input.shopName} (default)`, {}],
      ];
      for (const [channel, name, fields] of senders) {
        await execute(
          `INSERT IGNORE INTO messaging_senders (shop_id, channel, name, provider, status, is_default, from_name, from_email, sms_header)
           VALUES (?, ?, ?, 'simulator', 'active', 1, ?, ?, ?)`,
          [shopId(), channel, name.slice(0, 120), fields.from_name ?? null, fields.from_email ?? null, fields.sms_header ?? null],
          tx,
        );
      }
      const existing = await queryOne<RowDataPacket & { total: number }>('SELECT COUNT(*) AS total FROM customer_segments WHERE shop_id = ?', [shopId()], tx);
      if (Number(existing?.total ?? 0) === 0) {
        for (const segment of segments(region)) {
          await execute(
            `INSERT INTO customer_segments (shop_id, name, description, segment_type, rules, rules_operator, color, icon)
             VALUES (?, ?, ?, 'auto', ?, 'all', ?, ?)`,
            [shopId(), segment.name, segment.description, JSON.stringify(segment.rules), segment.color, segment.icon],
            tx,
          );
        }
      }
    },
  },
  {
    key: 'content',
    async run(_context, tx) {
      for (const menu of BASE_MENUS) {
        await execute('INSERT IGNORE INTO cms_menus (shop_id, slug, name, is_active) VALUES (?, ?, ?, 1)', [shopId(), menu.slug, menu.name], tx);
      }
      for (const [index, folder] of BASE_MEDIA_FOLDERS.entries()) {
        const exists = await queryOne<RowDataPacket & { id: number }>(
          'SELECT id FROM media_folders WHERE shop_id = ? AND parent_id IS NULL AND slug = ? LIMIT 1',
          [shopId(), folder.slug],
          tx,
        );
        if (!exists) {
          await execute(
            'INSERT INTO media_folders (shop_id, parent_id, name, slug, path, depth, sort_order) VALUES (?, NULL, ?, ?, ?, 0, ?)',
            [shopId(), folder.name, folder.slug, folder.slug, index * 10],
            tx,
          );
        }
      }
      await execute(
        "INSERT IGNORE INTO cms_blogs (shop_id, slug, title, description, is_active) VALUES (?, 'journal', 'Journal', 'Stories, guides and news.', 1)",
        [shopId()],
        tx,
      );
      for (const [index, group] of BASE_FAQ_GROUPS.entries()) {
        await execute(
          'INSERT IGNORE INTO cms_faq_groups (shop_id, slug, name, description, sort_order, is_active) VALUES (?, ?, ?, ?, ?, 1)',
          [shopId(), group.slug, group.name, group.description, index * 10],
          tx,
        );
      }
      await execute('INSERT IGNORE INTO announcement_settings (shop_id) VALUES (?)', [shopId()], tx);
    },
  },
  {
    key: 'theme',
    async run({ vertical }) {
      // Outside the step transaction: install() runs its own, and a theme is
      // idempotent by "is there any theme yet".
      const existing = await queryOne<RowDataPacket & { total: number }>('SELECT COUNT(*) AS total FROM shop_themes WHERE shop_id = ?', [shopId()]);
      if (Number(existing?.total ?? 0) > 0) return;
      // The theme picked during signup, if any; otherwise the one made for what the store sells.
      const chosen = await queryOne<RowDataPacket & { value: string | null }>("SELECT value FROM settings WHERE shop_id = ? AND setting_key = 'online_store.initial_theme' LIMIT 1", [shopId()]);
      let pick: { handle?: string; style?: string | null } = {};
      try {
        pick = chosen?.value ? (JSON.parse(chosen.value) as typeof pick) : {};
      } catch {
        pick = {};
      }
      const content = { heading: vertical.hero.heading, body: vertical.hero.body, cta: vertical.hero.cta };
      const system = { id: null, label: 'provisioning' };
      if (pick.handle && pick.handle !== vertical.theme) {
        try {
          await themesService.install({ handle: pick.handle, preset: pick.style ?? null, publish: true, content }, system, { skipLimit: true });
          return;
        } catch (error) {
          // A theme retired since signup: fall back to the vertical's own.
          logger.warn('shops.initial_theme_unavailable', { handle: pick.handle, error: error instanceof Error ? error.message : String(error) });
        }
      }
      // The home page opens with the store's own headline, not the theme's sample copy.
      await themesService.install({ handle: vertical.theme, preset: pick.handle === vertical.theme ? (pick.style ?? null) : null, publish: true, content }, system, { skipLimit: true });
    },
  },
  {
    key: 'home_page',
    async run({ vertical }, tx) {
      const existing = await queryOne<RowDataPacket & { id: number }>(
        "SELECT id FROM page_templates WHERE shop_id = ? AND template_key = 'home' LIMIT 1",
        [shopId()],
        tx,
      );
      if (existing) return;
      const templateId = await insert(
        "INSERT INTO page_templates (shop_id, template_key, name, description, is_system, is_active) VALUES (?, 'home', 'Home page', 'The storefront home page.', 1, 1)",
        [shopId()],
        tx,
      );
      const starter = await themesService.starterHome(vertical.theme);
      for (const [index, section] of starter.entries()) {
        const settingsValue: Record<string, unknown> = { ...section.settings };
        if (section.key === 'hero') {
          Object.assign(settingsValue, { heading: vertical.hero.heading, body: vertical.hero.body, cta_label: vertical.hero.cta, cta_link: { type: 'url', url: '/shop' } });
        }
        const sectionId = await insert(
          "INSERT INTO content_sections (shop_id, section_key, surface, name, settings) VALUES (?, ?, 'page', ?, ?)",
          [shopId(), section.key, section.name, JSON.stringify(settingsValue)],
          tx,
        );
        await execute(
          "INSERT INTO content_section_assignments (shop_id, section_id, owner_type, owner_id, sort_order, is_enabled) VALUES (?, ?, 'template', ?, ?, 1)",
          [shopId(), sectionId, templateId, (index + 1) * 10],
          tx,
        );
        if (section.key === 'promises') {
          for (const [blockIndex, promise] of vertical.promises.entries()) {
            await execute(
              `INSERT INTO content_section_blocks (shop_id, section_id, block_type, sort_order, is_enabled, heading, body, link_type, settings)
               VALUES (?, ?, 'item', ?, 1, ?, ?, 'none', ?)`,
              [shopId(), sectionId, blockIndex, promise.title, promise.body, JSON.stringify({ icon: promise.icon, title: promise.title, body: promise.body })],
              tx,
            );
          }
        }
      }
    },
  },
  {
    key: 'onboarding',
    async run(_context, tx) {
      for (const [index, task] of ONBOARDING_TASKS.entries()) {
        await execute(
          `INSERT IGNORE INTO shop_setup_tasks (shop_id, task_key, kind, status, meta, sort_order)
           VALUES (?, ?, 'onboarding', 'pending', ?, ?)`,
          [shopId(), task.key, JSON.stringify({ title: task.title }), index * 10],
          tx,
        );
      }
    },
  },
];

// ── the provisioner ──────────────────────────────────────────────────────────

async function stepDone(key: string): Promise<boolean> {
  const row = await queryOne<RowDataPacket & { status: string }>(
    "SELECT status FROM shop_setup_tasks WHERE shop_id = ? AND task_key = ? AND kind = 'provisioning'",
    [shopId(), `provision.${key}`],
  );
  return row?.status === 'done';
}

async function recordStep(key: string, status: 'done' | 'failed', error: string | null, sortOrder: number): Promise<void> {
  await execute(
    `INSERT INTO shop_setup_tasks (shop_id, task_key, kind, status, attempts, last_error, sort_order, completed_at)
     VALUES (?, ?, 'provisioning', ?, 1, ?, ?, ${status === 'done' ? 'NOW()' : 'NULL'})
     ON DUPLICATE KEY UPDATE status = VALUES(status), attempts = attempts + 1, last_error = VALUES(last_error),
                             completed_at = VALUES(completed_at)`,
    [shopId(), `provision.${key}`, status, error ? error.slice(0, 500) : null, sortOrder],
  );
}

function provisionInputFor(shop: ShopContext, row: { email: string | null; phone: string | null }): ProvisionInput {
  return {
    shopName: shop.name,
    handle: shop.handle,
    vertical: shop.vertical,
    countryCode: shop.countryCode,
    currency: shop.currency,
    timezone: shop.timezone,
    locale: shop.locale,
    email: row.email,
    phone: row.phone,
  };
}

/**
 * What the merchant chose while signing up — a theme and style, how far along
 * they are, where they will sell — kept for provisioning (which may run
 * later, as a job) and for tailoring the setup guide.
 */
async function rememberOnboarding(input: CreateShopInput): Promise<void> {
  const rows: [string, string, string, unknown][] = [];
  if (input.theme) rows.push(['online_store', 'online_store.initial_theme', 'Theme chosen at signup', { handle: input.theme, style: input.themeStyle ?? null }]);
  if (input.onboarding) rows.push(['onboarding', 'onboarding.profile', 'What the merchant told onboarding', input.onboarding]);
  for (const [group, key, label, value] of rows) {
    await execute(
      `INSERT INTO settings (shop_id, group_key, setting_key, label, value, default_value, value_type, description, is_public, sort_order)
       VALUES (?, ?, ?, ?, ?, NULL, 'json', NULL, 0, 0)
       ON DUPLICATE KEY UPDATE value = VALUES(value)`,
      [shopId(), group, key, label, JSON.stringify(value)],
    );
  }
}

export const shopProvisioner = {
  /** A free handle from a shop name: "Blue Bird Books" → "blue-bird-books", then "-2", "-3"… */
  async suggestHandle(name: string): Promise<string> {
    const base = slugify(name) || 'store';
    const safe = validHandle(base) ? base : `${base}-store`.replace(/^-+/, '');
    for (let attempt = 0; attempt < 50; attempt += 1) {
      const candidate = attempt === 0 ? safe : `${safe.slice(0, 55)}-${attempt + 1}`;
      if (validHandle(candidate) && !(await shopsRepository.handleTaken(candidate))) return candidate;
    }
    return `${safe.slice(0, 40)}-${randomBytes(3).toString('hex')}`;
  },

  /**
   * Phase 1: the shop on the control plane, owned by `ownerUserId`. Returns
   * the new shop; call `provision` (or let `create` do it) for phase 2.
   */
  async create(input: CreateShopInput, ownerUserId: number): Promise<ShopContext> {
    const name = input.name.trim();
    if (name.length < 2) throw ApiError.validation({ name: ['Give the store a name of at least two characters.'] });
    const country = input.countryCode.trim().toUpperCase();
    if (!/^[A-Z]{2}$/.test(country)) throw ApiError.validation({ country_code: ['Use a two-letter country code, such as IN or US.'] });
    const vertical = input.vertical && VERTICAL_KEYS.includes(input.vertical) ? input.vertical : 'general';

    let handle = input.handle?.trim().toLowerCase() || (await this.suggestHandle(name));
    if (!validHandle(handle)) {
      throw ApiError.validation({ handle: ['Use 1–60 lowercase letters, numbers and hyphens, not starting or ending with a hyphen.'] });
    }
    if (await shopsRepository.handleTaken(handle)) {
      if (input.handle) throw ApiError.conflict(`The address ${handle} is taken.`, 'SLUG_TAKEN');
      handle = await this.suggestHandle(name);
    }

    const region = regionFor(country, { currency: input.currency, timezone: input.timezone, locale: input.locale });
    const plan = (await shopsRepository.planByHandle(input.plan ?? 'starter')) ?? (await shopsRepository.planByHandle('starter'));
    if (!plan) throw ApiError.internal('No plans are configured on this platform.');
    const podId = await shopsRepository.podForNewShop();

    const shopPublicId = randomUUID();
    const now = new Date();
    const trialEnds = plan.trial_days > 0 ? new Date(now.getTime() + plan.trial_days * 86_400_000) : null;
    // The trial is the first period. Without one, the period "ends" now, so
    // the next billing run bills the first paid period straight away.
    const periodEnd = trialEnds ?? now;
    // Billed in the store's own currency where the plan has a price in it.
    const price = await planPriceFor(plan, region.currency);

    const id = await withTransaction(async (tx) => {
      const organizationId =
        (await shopsRepository.organizationOf(ownerUserId, tx)) ??
        (await shopsRepository.createOrganization(
          { publicId: randomUUID(), name, ownerUserId, email: input.email ?? null, countryCode: country },
          tx,
        ));
      const newShopId = await shopsRepository.createShop(
        {
          publicId: shopPublicId,
          handle,
          name,
          email: input.email ?? null,
          phone: input.phone ?? null,
          organizationId,
          ownerUserId,
          podId,
          planId: plan.id,
          vertical,
          countryCode: country,
          currency: region.currency,
          timezone: region.timezone,
          locale: region.locale,
          weightUnit: region.weightUnit,
          taxEngine: region.taxEngine,
        },
        tx,
      );
      await shopsRepository.addDomain(
        {
          shopId: newShopId,
          hostname: `${handle}.${env.platform.storefrontDomain}`,
          kind: 'platform',
          primary: true,
          verified: true,
          token: randomBytes(16).toString('hex'),
        },
        tx,
      );
      await shopsRepository.createSubscription(
        {
          shopId: newShopId,
          planId: plan.id,
          status: trialEnds ? 'trialing' : 'active',
          price: price.amount,
          currency: price.currency,
          interval: plan.billing_interval,
          trialEndsAt: trialEnds,
          periodStart: now,
          periodEnd,
          provider: billingProvider().name,
        },
        tx,
      );
      await shopsRepository.addOwner(newShopId, ownerUserId, tx);
      return newShopId;
    }, controlPlane);

    shopDirectory.invalidate();
    const shop = await shopDirectory.byId(id);
    if (!shop) throw ApiError.internal('The store was created but could not be read back.');
    if (input.theme || input.onboarding) await tenancy.run(shop, () => rememberOnboarding(input));
    metrics.counter('shops_created_total', { vertical, country }).inc();
    logger.info('shops.created', { shop_id: id, handle, vertical, country, plan: plan.handle, pod_id: podId });
    return shop;
  },

  /**
   * Phase 2. Safe to run any number of times; completed steps are skipped.
   * Returns true when the shop is fully provisioned.
   */
  async provision(shop: ShopContext): Promise<boolean> {
    const row = await shopsRepository.byId(shop.id);
    if (!row) throw new PermanentJobError(`Shop ${shop.id} does not exist.`);
    if (row.status === 'closed') return false;

    return tenancy.run(shop, async () => {
      const context: StepContext = {
        shop,
        input: provisionInputFor(shop, row),
        region: regionFor(shop.countryCode, { currency: shop.currency, timezone: shop.timezone, locale: shop.locale }),
        vertical: verticalFor(shop.vertical),
      };

      for (const [index, step] of STEPS.entries()) {
        if (await stepDone(step.key)) continue;
        const started = Date.now();
        try {
          if (step.key === 'theme') await step.run(context, controlPlane);
          else await withTransaction((tx) => step.run(context, tx));
          await recordStep(step.key, 'done', null, index * 10);
          metrics.histogram('shop_provision_step_seconds', { step: step.key }).observe((Date.now() - started) / 1000);
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          await recordStep(step.key, 'failed', message, index * 10).catch(() => undefined);
          logger.error('shops.provision_step_failed', { shop_id: shop.id, step: step.key, error: message });
          throw error;
        }
      }

      if (row.status === 'provisioning') {
        await shopsRepository.update(shop.id, { status: 'active', provisioned_at: new Date() });
        shopDirectory.invalidate(shop.id);
      }
      logger.info('shops.provisioned', { shop_id: shop.id, handle: shop.handle });
      return true;
    });
  },

  /**
   * Brings a shop that existed before provisioning (the founding shop of an
   * upgraded installation) up to what provisioning would have given it —
   * without re-seeding anything it already has its own version of. Only the
   * theme and the setup guide are added; every other step is recorded as done
   * so a later `provision` never lays generic defaults over a live catalogue.
   */
  async adopt(shop: ShopContext): Promise<void> {
    await tenancy.run(shop, async () => {
      const vertical = verticalFor(shop.vertical);
      const themes = await queryOne<RowDataPacket & { total: number }>('SELECT COUNT(*) AS total FROM shop_themes WHERE shop_id = ?', [shopId()]);
      if (Number(themes?.total ?? 0) === 0) {
        await themesService.install({ handle: vertical.theme, publish: true }, { id: null, label: 'adoption' }, { skipLimit: true });
      }
      await withTransaction(async (tx) => {
        // Templates for notifications the shop never had (shipping emails,
        // staff alerts). INSERT IGNORE against (shop, event, channel, locale):
        // a template the shop already wrote is never replaced.
        for (const template of BASE_TEMPLATES) {
          await execute(
            `INSERT IGNORE INTO notification_templates
               (shop_id, event_key, channel, category, locale, name, subject, body, is_transactional, is_active)
             VALUES (?, ?, ?, ?, 'en-IN', ?, ?, ?, ?, 1)`,
            [shopId(), template.eventKey, template.channel, template.category, template.name, template.subject ?? null, template.body, template.category === 'marketing' ? 0 : 1],
            tx,
          );
        }
        const onboarding = STEPS.find((step) => step.key === 'onboarding')!;
        await onboarding.run(
          {
            shop,
            input: provisionInputFor(shop, { email: null, phone: null }),
            region: regionFor(shop.countryCode, { currency: shop.currency, timezone: shop.timezone, locale: shop.locale }),
            vertical,
          },
          tx,
        );
      });
      for (const [index, step] of STEPS.entries()) {
        if (!(await stepDone(step.key))) await recordStep(step.key, 'done', null, index * 10);
      }
    });
    logger.info('shops.adopted', { shop_id: shop.id, handle: shop.handle });
  },

  /** Create and provision; provisioning failures fall back to the retrying job. */
  async createAndProvision(input: CreateShopInput, ownerUserId: number): Promise<ShopContext> {
    const shop = await this.create(input, ownerUserId);
    try {
      await this.provision(shop);
    } catch (error) {
      logger.warn('shops.provision_deferred', { shop_id: shop.id, error: error instanceof Error ? error.message : String(error) });
      await jobQueue.enqueue('shops.provision', {}, { shopId: shop.id, queue: 'default', maxAttempts: 10, uniqueKey: `shops.provision:${shop.id}` });
    }
    return (await shopDirectory.byId(shop.id)) ?? shop;
  },

  /** Setup progress, for the admin's "setting up your store" and setup guide. */
  async progress() {
    const rows = await query<RowDataPacket & { task_key: string; kind: string; status: string; last_error: string | null; meta: unknown; completed_at: Date | null }>(
      'SELECT task_key, kind, status, last_error, meta, completed_at FROM shop_setup_tasks WHERE shop_id = ? ORDER BY kind, sort_order',
      [shopId()],
    );
    const provisioning = rows.filter((row) => row.kind === 'provisioning');
    return {
      provisioning: {
        done: provisioning.filter((row) => row.status === 'done').length,
        total: STEPS.length,
        failed: provisioning.filter((row) => row.status === 'failed').map((row) => ({ step: row.task_key.replace('provision.', ''), error: row.last_error })),
      },
      onboarding: rows
        .filter((row) => row.kind === 'onboarding')
        .map((row) => ({
          key: row.task_key,
          title: (typeof row.meta === 'string' ? JSON.parse(row.meta) : (row.meta as { title?: string } | null))?.title ?? row.task_key,
          status: row.status,
          completed_at: row.completed_at,
        })),
    };
  },
};

defineJob({
  type: 'shops.provision',
  queue: 'default',
  shopScoped: true,
  maxAttempts: 10,
  timeoutMs: 5 * 60_000,
  async handler(_payload, context) {
    if (!context.shop) throw new PermanentJobError('shops.provision needs a shop.');
    await shopProvisioner.provision(context.shop);
  },
});

/**
 * Runs `adopt` for every live shop that has no provisioning record — shops
 * that predate provisioning. Enqueued once at boot; idempotent, and cheap
 * when there is nothing to do.
 */
defineJob({
  type: 'shops.adopt_existing',
  queue: 'default',
  shopScoped: false,
  maxAttempts: 3,
  timeoutMs: 5 * 60_000,
  async handler() {
    const shops = await query<RowDataPacket & { id: number }>(
      "SELECT id FROM shops WHERE status IN ('active','paused','frozen') AND provisioned_at IS NOT NULL ORDER BY id",
      [],
      controlPlane,
    );
    for (const { id } of shops) {
      const shop = await shopDirectory.byId(Number(id));
      if (!shop) continue;
      const adopted = await tenancy.run(shop, () =>
        queryOne<RowDataPacket & { total: number }>(
          "SELECT COUNT(*) AS total FROM shop_setup_tasks WHERE shop_id = ? AND kind = 'provisioning'",
          [shopId()],
        ),
      );
      if (Number(adopted?.total ?? 0) > 0) continue;
      await shopProvisioner.adopt(shop);
    }
  },
});
