import { ApiError } from '../../core/ApiError';
import { withTransaction } from '../../db/transaction';
import { auditService } from '../../shared/audit.service';
import { connectionsService } from '../../platform/integrations/connections.service';
import { roundMoney } from '../../platform/money/currency';
import { DESTINATION_ENGINES, taxService, shopOrigin } from '../../platform/tax/taxService';
import { tenancy } from '../../platform/tenancy/context';
import { taxRepository, type TaxClassRow, type TaxRegistrationRow } from './tax.repository';
import { controlPlane, execute } from '../../db/pool';
import { shopDirectory } from '../../platform/shops/shopDirectory';

/**
 * Settings → Taxes: the shop's tax classes (what rate a product carries, or
 * whether it is exempt) and, for regimes that tax by destination, where the
 * shop is registered to collect.
 */

interface Actor {
  id: number;
  email: string;
}

interface Meta {
  ip: string | null;
  userAgent: string | null;
}

function presentClass(row: TaxClassRow) {
  return {
    id: row.id,
    code: row.code,
    name: row.name,
    rate: Number(row.gst_rate),
    inclusive: row.is_inclusive === 1,
    exempt: row.is_exempt === 1,
    hsn_code: row.hsn_code,
    is_default: row.is_default === 1,
    is_active: row.is_active === 1,
    product_count: Number(row.product_count ?? 0),
  };
}

function presentRegistration(row: TaxRegistrationRow) {
  return {
    id: row.id,
    country_code: row.country_code,
    region_code: row.region_code,
    name: row.name,
    registration_number: row.registration_number,
    rate: Number(row.rate),
    shipping_taxable: row.shipping_taxable === 1,
    is_active: row.is_active === 1,
  };
}

function isDuplicate(error: unknown): boolean {
  return error instanceof Error && (error as Error & { code?: string }).code === 'ER_DUP_ENTRY';
}

export const taxAdminService = {
  async overview() {
    const shop = tenancy.current();
    const [classes, registrations, connected, reports] = await Promise.all([
      taxRepository.classes(),
      taxRepository.registrations(),
      connectionsService.resolveDefault('tax').catch(() => null),
      taxRepository.reportSummary(),
    ]);
    const reported = (kind: 'sale' | 'refund') => reports.find((row) => row.kind === kind);
    const destinationBased = DESTINATION_ENGINES.has(shop.taxEngine);
    return {
      engine: shop.taxEngine,
      /** Where the rate comes from: the product's class, or the delivery address. */
      rate_source: destinationBased ? 'destination' : 'class',
      /** Class-rate regimes: delivery taxed like the goods. Destination regimes decide per registration. */
      shipping_taxable: shop.taxShipping !== false,
      tax_service: connected
        ? {
            provider: connected.row.provider,
            name: connected.row.name,
            // Sales and refunds reported for filing (on fulfilment and refund).
            reported: {
              sales: Number(reported('sale')?.total ?? 0),
              refunds: Number(reported('refund')?.total ?? 0),
              last_reported_at: reported('sale')?.last_reported_at ?? null,
            },
          }
        : null,
      classes: classes.map(presentClass),
      registrations: registrations.map(presentRegistration),
      // A destination-taxed store with nowhere registered collects nothing;
      // saying so is the setup prompt.
      collecting: !destinationBased || connected !== null || registrations.some((row) => row.is_active === 1),
    };
  },

  /** Store-wide tax settings: whether delivery is taxed (class-rate regimes). */
  async updateSettings(input: { shipping_taxable?: boolean }, actor: Actor, meta: Meta) {
    const shop = tenancy.current();
    if (input.shipping_taxable !== undefined) {
      await execute('UPDATE shops SET tax_shipping = ? WHERE id = ?', [input.shipping_taxable ? 1 : 0, shop.id], controlPlane);
      shopDirectory.invalidate(shop.id);
      taxService.invalidate();
      await auditService.log({
        actorId: actor.id,
        actorLabel: actor.email,
        action: 'tax.settings_updated',
        entityType: 'shop',
        entityId: shop.id,
        summary: input.shipping_taxable ? 'Delivery is now taxed like the goods' : 'Delivery is no longer taxed',
        changes: { shipping_taxable: input.shipping_taxable },
        ip: meta.ip,
        userAgent: meta.userAgent,
      });
    }
    const fresh = await shopDirectory.byId(shop.id);
    return tenancy.run(fresh ?? shop, () => this.overview());
  },

  // ── classes ──────────────────────────────────────────────────────────────

  async createClass(input: Record<string, unknown>, actor: Actor, meta: Meta) {
    try {
      const id = await withTransaction(async (tx) => {
        const created = await taxRepository.createClass(input, tx);
        if (input.is_default) await taxRepository.makeDefault(created, tx);
        return created;
      });
      await auditService.log({ actorId: actor.id, actorLabel: actor.email, action: 'tax.class_created', entityType: 'tax_class', entityId: id, summary: `Created tax class ${String(input.name)}`, changes: input, ip: meta.ip, userAgent: meta.userAgent });
      return { class: presentClass((await taxRepository.classById(id))!) };
    } catch (error) {
      if (isDuplicate(error)) throw ApiError.conflict('A tax class with that code already exists.', 'SLUG_TAKEN');
      throw error;
    }
  },

  async updateClass(id: number, input: Record<string, unknown>, actor: Actor, meta: Meta) {
    const existing = await taxRepository.classById(id);
    if (!existing) throw ApiError.notFound('Tax class');
    if (existing.is_default === 1 && input.is_active === false) {
      throw ApiError.conflict('The default tax class cannot be switched off. Make another class the default first.');
    }
    try {
      await withTransaction(async (tx) => {
        await taxRepository.updateClass(id, input, tx);
        if (input.is_default === true) await taxRepository.makeDefault(id, tx);
      });
    } catch (error) {
      if (isDuplicate(error)) throw ApiError.conflict('A tax class with that code already exists.', 'SLUG_TAKEN');
      throw error;
    }
    await auditService.log({ actorId: actor.id, actorLabel: actor.email, action: 'tax.class_updated', entityType: 'tax_class', entityId: id, summary: `Updated tax class ${existing.name}`, changes: input, ip: meta.ip, userAgent: meta.userAgent });
    return { class: presentClass((await taxRepository.classById(id))!) };
  },

  // ── registrations ────────────────────────────────────────────────────────

  async createRegistration(input: Record<string, unknown>, actor: Actor, meta: Meta) {
    try {
      const id = await taxRepository.createRegistration(input);
      taxService.invalidate();
      await auditService.log({ actorId: actor.id, actorLabel: actor.email, action: 'tax.registration_created', entityType: 'tax_registration', entityId: id, summary: `Collecting ${String(input.name)} at ${String(input.rate)}%`, changes: input, ip: meta.ip, userAgent: meta.userAgent });
      return { registration: presentRegistration((await taxRepository.registrationById(id))!) };
    } catch (error) {
      if (isDuplicate(error)) throw ApiError.conflict('The store is already registered there. Edit that registration instead.');
      throw error;
    }
  },

  async updateRegistration(id: number, input: Record<string, unknown>, actor: Actor, meta: Meta) {
    const existing = await taxRepository.registrationById(id);
    if (!existing) throw ApiError.notFound('Tax registration');
    try {
      await taxRepository.updateRegistration(id, input);
    } catch (error) {
      if (isDuplicate(error)) throw ApiError.conflict('The store is already registered there.');
      throw error;
    }
    taxService.invalidate();
    await auditService.log({ actorId: actor.id, actorLabel: actor.email, action: 'tax.registration_updated', entityType: 'tax_registration', entityId: id, summary: `Updated ${existing.name}`, changes: input, ip: meta.ip, userAgent: meta.userAgent });
    return { registration: presentRegistration((await taxRepository.registrationById(id))!) };
  },

  async deleteRegistration(id: number, actor: Actor, meta: Meta) {
    const existing = await taxRepository.registrationById(id);
    if (!existing) throw ApiError.notFound('Tax registration');
    await taxRepository.deleteRegistration(id);
    taxService.invalidate();
    await auditService.log({ actorId: actor.id, actorLabel: actor.email, action: 'tax.registration_deleted', entityType: 'tax_registration', entityId: id, summary: `Stopped collecting ${existing.name}`, ip: meta.ip, userAgent: meta.userAgent });
    return { deleted: true };
  },

  /**
   * "What would a customer pay here?" — the settings screen's check that the
   * registrations say what the merchant meant, without placing an order.
   */
  async preview(input: { region: string | null; postal_code: string | null; amount: number; shipping: number; exempt: boolean; tax_class_id?: number | null }) {
    const shop = tenancy.current();
    const round = (value: number) => roundMoney(value, shop.currency);
    // A class-rated store (GST, VAT) charges the product's class: the one
    // asked about, or the default a new product gets.
    const taxClass = input.tax_class_id
      ? await taxRepository.classById(input.tax_class_id)
      : ((await taxRepository.classes()).find((row) => row.is_default === 1) ?? null);
    if (input.tax_class_id && !taxClass) throw ApiError.validation({ tax_class_id: ['That tax class does not exist.'] });
    const quote = await taxService.quote({
      lines: [
        {
          id: 'preview',
          amount: input.amount,
          quantity: 1,
          unitPrice: input.amount,
          discount: 0,
          rate: taxClass ? Number(taxClass.gst_rate) : 0,
          inclusive: taxClass ? taxClass.is_inclusive === 1 : false,
          exempt: input.exempt || taxClass?.is_exempt === 1,
        },
      ],
      shipping: input.shipping,
      destination: { country: shop.countryCode, region: input.region, postalCode: input.postal_code, city: null, line1: null },
      // Where the goods leave from decides intra- or inter-state GST.
      originRegion: (await shopOrigin()).region,
    });
    return {
      source: quote.source,
      tax: quote.tax,
      shipping_tax: quote.shippingTax,
      tax_lines: quote.taxLines,
      total: round(input.amount + input.shipping + quote.addedToTotal),
    };
  },
};
