import { ApiError } from '../../core/ApiError';
import { auditService } from '../../shared/audit.service';
import type { AuthenticatedAdmin } from '../auth/auth.types';
import {
  shippingRepository,
  type ShippingRateRow,
  type ShippingCarrierRow,
  type CodRuleRow,
  type PincodeServiceabilityRow,
} from './shipping.repository';
import { formatMoney } from '../../platform/shops/format';
import { shopPricing } from '../../platform/commerce/shopPricing';
import { shippingQuote } from './shippingQuote';
import { shippingZonesService } from './zones';

interface ActorMeta {
  ip: string | null;
  userAgent: string | null;
  requestId: string;
}

function presentRate(row: ShippingRateRow) {
  return {
    id: row.id,
    name: row.name,
    zone: row.zone,
    zone_id: row.zone_id === null ? null : Number(row.zone_id),
    method: row.method,
    min_order_amount: Number(row.min_order_amount),
    max_order_amount: row.max_order_amount !== null ? Number(row.max_order_amount) : null,
    min_weight_grams: row.min_weight_grams,
    max_weight_grams: row.max_weight_grams,
    rate: Number(row.rate),
    free_above_amount: row.free_above_amount !== null ? Number(row.free_above_amount) : null,
    eta_min_days: row.eta_min_days,
    eta_max_days: row.eta_max_days,
    is_active: row.is_active === 1,
    priority: row.priority,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

function presentCarrier(row: ShippingCarrierRow) {
  return {
    id: row.id,
    code: row.code,
    name: row.name,
    tracking_url_template: row.tracking_url_template,
    api_provider: row.api_provider,
    supports_cod: row.supports_cod === 1,
    supports_reverse_pickup: row.supports_reverse_pickup === 1,
    logo_media_id: row.logo_media_id,
    is_active: row.is_active === 1,
    priority: row.priority,
  };
}

function presentCodRule(row: CodRuleRow) {
  return {
    id: row.id,
    name: row.name,
    is_active: row.is_active === 1,
    min_order_amount: Number(row.min_order_amount),
    max_order_amount: row.max_order_amount !== null ? Number(row.max_order_amount) : null,
    cod_fee: Number(row.cod_fee),
    prepaid_discount_amount: Number(row.prepaid_discount_amount),
    prepaid_discount_percent: Number(row.prepaid_discount_percent),
    requires_otp_confirmation: row.requires_otp_confirmation === 1,
    max_open_cod_orders: row.max_open_cod_orders,
    block_if_rto_count_gte: row.block_if_rto_count_gte,
    blocked_pincodes: row.blocked_pincodes ? JSON.parse(row.blocked_pincodes) : [],
    blocked_categories: row.blocked_categories ? JSON.parse(row.blocked_categories) : [],
    priority: row.priority,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

function presentPincode(row: PincodeServiceabilityRow) {
  return {
    id: row.id,
    pincode: row.pincode,
    city: row.city,
    district: row.district,
    state: row.state,
    state_code: row.state_code,
    zone: row.zone,
    is_serviceable: row.is_serviceable === 1,
    prepaid_available: row.prepaid_available === 1,
    cod_available: row.cod_available === 1,
    express_available: row.express_available === 1,
    standard_eta_min_days: row.standard_eta_min_days,
    standard_eta_max_days: row.standard_eta_max_days,
    express_eta_days: row.express_eta_days,
    default_carrier_id: row.default_carrier_id,
    default_carrier_name: row.default_carrier_name ?? null,
    order_cutoff_time: row.order_cutoff_time,
    notes: row.notes,
    source: row.source,
    updated_at: row.updated_at,
  };
}

export const shippingService = {
  // ── Rates ────────────────────────────────────────────────────────────────

  async listRates() {
    const rows = await shippingRepository.listRates();
    return { rates: rows.map(presentRate) };
  },

  async getRate(id: number) {
    const row = await shippingRepository.findRateById(id);
    if (!row) throw ApiError.notFound('Shipping rate');
    return { rate: presentRate(row) };
  },

  async createRate(
    data: Parameters<typeof shippingRepository.createRate>[0],
    admin: AuthenticatedAdmin,
    meta: ActorMeta,
  ) {
    await shippingZonesService.assertZone(data.zone_id);
    const id = await shippingRepository.createRate(data);
    await auditService.log({
      actorId: admin.id,
      actorLabel: admin.email,
      action: 'shipping.rate_created',
      entityType: 'shipping_rate',
      entityId: id,
      summary: `Created shipping rate "${data.name}" (${data.method}, ${formatMoney(Number(data.rate))})`,
      changes: data,
      ip: meta.ip,
      userAgent: meta.userAgent,
    });

    const row = await shippingRepository.findRateById(id);
    shopPricing.invalidate();
    shippingQuote.invalidate();
    return { rate: presentRate(row!) };
  },

  async updateRate(
    id: number,
    data: Record<string, unknown>,
    admin: AuthenticatedAdmin,
    meta: ActorMeta,
  ) {
    await shippingZonesService.assertZone(data.zone_id as number | null | undefined);
    const existing = await shippingRepository.findRateById(id);
    if (!existing) throw ApiError.notFound('Shipping rate');

    await shippingRepository.updateRate(id, data);
    await auditService.log({
      actorId: admin.id,
      actorLabel: admin.email,
      action: 'shipping.rate_updated',
      entityType: 'shipping_rate',
      entityId: id,
      summary: `Updated shipping rate "${existing.name}"`,
      changes: data,
      ip: meta.ip,
      userAgent: meta.userAgent,
    });

    const updated = await shippingRepository.findRateById(id);
    shopPricing.invalidate();
    shippingQuote.invalidate();
    return { rate: presentRate(updated!) };
  },

  async deleteRate(id: number, admin: AuthenticatedAdmin, meta: ActorMeta) {
    const existing = await shippingRepository.findRateById(id);
    if (!existing) throw ApiError.notFound('Shipping rate');

    await shippingRepository.deleteRate(id);
    await auditService.log({
      actorId: admin.id,
      actorLabel: admin.email,
      action: 'shipping.rate_deleted',
      entityType: 'shipping_rate',
      entityId: id,
      summary: `Deleted shipping rate "${existing.name}"`,
      ip: meta.ip,
      userAgent: meta.userAgent,
    });

    shopPricing.invalidate();
    shippingQuote.invalidate();
    return { success: true };
  },

  // ── Carriers ─────────────────────────────────────────────────────────────

  async listCarriers() {
    const rows = await shippingRepository.listCarriers();
    return { carriers: rows.map(presentCarrier) };
  },

  async updateCarrier(
    id: number,
    data: Record<string, unknown>,
    admin: AuthenticatedAdmin,
    meta: ActorMeta,
  ) {
    const existing = await shippingRepository.findCarrierById(id);
    if (!existing) throw ApiError.notFound('Shipping carrier');

    await shippingRepository.updateCarrier(id, data);
    await auditService.log({
      actorId: admin.id,
      actorLabel: admin.email,
      action: 'shipping.carrier_updated',
      entityType: 'shipping_carrier',
      entityId: id,
      summary: `Updated carrier "${existing.name}"`,
      changes: data,
      ip: meta.ip,
      userAgent: meta.userAgent,
    });

    const updated = await shippingRepository.findCarrierById(id);
    return { carrier: presentCarrier(updated!) };
  },

  // ── COD Rules ────────────────────────────────────────────────────────────

  async listCodRules() {
    const rows = await shippingRepository.listCodRules();
    return { cod_rules: rows.map(presentCodRule) };
  },

  async updateCodRule(
    id: number,
    data: Record<string, unknown>,
    admin: AuthenticatedAdmin,
    meta: ActorMeta,
  ) {
    const existing = await shippingRepository.findCodRuleById(id);
    if (!existing) throw ApiError.notFound('COD rule');

    await shippingRepository.updateCodRule(id, data);
    await auditService.log({
      actorId: admin.id,
      actorLabel: admin.email,
      action: 'shipping.cod_rule_updated',
      entityType: 'cod_rule',
      entityId: id,
      summary: `Updated COD rule "${existing.name}"`,
      changes: data,
      ip: meta.ip,
      userAgent: meta.userAgent,
    });

    const updated = await shippingRepository.findCodRuleById(id);
    shopPricing.invalidate();
    shippingQuote.invalidate();
    return { cod_rule: presentCodRule(updated!) };
  },

  // ── Pincode Serviceability ───────────────────────────────────────────────

  async lookupPincode(pincode: string) {
    const row = await shippingRepository.lookupPincode(pincode);
    if (!row) {
      // If not yet imported in the table, return a sensible default serviceability
      return {
        serviceability: {
          pincode,
          city: null,
          district: null,
          state: null,
          state_code: null,
          zone: 'rest_of_india',
          is_serviceable: true,
          prepaid_available: true,
          cod_available: true,
          express_available: false,
          standard_eta_min_days: 3,
          standard_eta_max_days: 7,
          express_eta_days: null,
          default_carrier_id: null,
          default_carrier_name: null,
          notes: 'Default serviceability (not explicitly customized)',
          source: 'default',
          updated_at: new Date(),
        },
      };
    }
    return { serviceability: presentPincode(row) };
  },

  async upsertPincode(
    data: Parameters<typeof shippingRepository.upsertPincode>[0],
    admin: AuthenticatedAdmin,
    meta: ActorMeta,
  ) {
    await shippingRepository.upsertPincode(data);
    await auditService.log({
      actorId: admin.id,
      actorLabel: admin.email,
      action: 'shipping.pincode_upserted',
      entityType: 'pincode_serviceability',
      summary: `Updated serviceability for pincode ${data.pincode}`,
      changes: data,
      ip: meta.ip,
      userAgent: meta.userAgent,
    });

    const row = await shippingRepository.lookupPincode(data.pincode);
    return { serviceability: presentPincode(row!) };
  },
};
