import { execute, insert, query, queryOne, pool, type Executor, type RowDataPacket } from '../../db/pool';
import { shopId } from '../../platform/tenancy/context';

// ── Row types ────────────────────────────────────────────────────────────────

export interface ShippingRateRow extends RowDataPacket {
  id: number;
  name: string;
  zone: 'local' | 'regional' | 'metro' | 'rest_of_india' | 'special' | 'all';
  zone_id: number | null;
  method: 'standard' | 'express' | 'pickup';
  rate_type: 'flat' | 'carrier';
  carrier_id: number | null;
  min_order_amount: string;
  max_order_amount: string | null;
  min_weight_grams: number;
  max_weight_grams: number | null;
  rate: string;
  free_above_amount: string | null;
  carrier_markup_percent: string;
  carrier_markup_amount: string;
  eta_min_days: number;
  eta_max_days: number;
  is_active: number;
  priority: number;
  created_at: Date;
  updated_at: Date;
}

export interface ShippingCarrierRow extends RowDataPacket {
  id: number;
  code: string;
  name: string;
  tracking_url_template: string | null;
  api_provider: string | null;
  supports_cod: number;
  supports_reverse_pickup: number;
  logo_media_id: number | null;
  is_active: number;
  priority: number;
}

export interface CodRuleRow extends RowDataPacket {
  id: number;
  name: string;
  is_active: number;
  min_order_amount: string;
  max_order_amount: string | null;
  cod_fee: string;
  prepaid_discount_amount: string;
  prepaid_discount_percent: string;
  requires_otp_confirmation: number;
  max_open_cod_orders: number;
  block_if_rto_count_gte: number | null;
  blocked_pincodes: string | null;
  blocked_categories: string | null;
  priority: number;
  created_at: Date;
  updated_at: Date;
}

export interface PincodeServiceabilityRow extends RowDataPacket {
  id: number;
  pincode: string;
  city: string | null;
  district: string | null;
  state: string | null;
  state_code: string | null;
  zone: 'local' | 'regional' | 'metro' | 'rest_of_india' | 'special';
  is_serviceable: number;
  prepaid_available: number;
  cod_available: number;
  express_available: number;
  standard_eta_min_days: number;
  standard_eta_max_days: number;
  express_eta_days: number | null;
  default_carrier_id: number | null;
  default_carrier_name?: string | null;
  order_cutoff_time: string | null;
  notes: string | null;
  source: string | null;
  updated_at: Date;
}

// ── Repository ───────────────────────────────────────────────────────────────

export const shippingRepository = {
  // ── Rates ────────────────────────────────────────────────────────────────

  async listRates(exec: Executor = pool): Promise<ShippingRateRow[]> {
    return query<ShippingRateRow>(
      `SELECT * FROM shipping_rates WHERE shop_id = ? ORDER BY priority ASC, id ASC`,
      [shopId()],
      exec,
    );
  },

  async findRateById(id: number, exec: Executor = pool): Promise<ShippingRateRow | null> {
    return queryOne<ShippingRateRow>(
      `SELECT * FROM shipping_rates WHERE shop_id = ? AND id = ? LIMIT 1`,
      [shopId(), id],
      exec,
    );
  },

  async createRate(
    data: {
      name: string;
      zone?: string;
      zone_id?: number | null;
      method?: string;
      rate_type?: 'flat' | 'carrier';
      carrier_id?: number | null;
      min_order_amount?: number;
      max_order_amount?: number | null;
      min_weight_grams?: number;
      max_weight_grams?: number | null;
      rate: number;
      free_above_amount?: number | null;
      carrier_markup_percent?: number;
      carrier_markup_amount?: number;
      eta_min_days?: number;
      eta_max_days?: number;
      is_active?: boolean;
      priority?: number;
    },
    exec: Executor = pool,
  ): Promise<number> {
    return insert(
      `INSERT INTO shipping_rates
         (shop_id, name, zone, zone_id, method, rate_type, carrier_id, min_order_amount, max_order_amount, min_weight_grams,
          max_weight_grams, rate, free_above_amount, carrier_markup_percent, carrier_markup_amount, eta_min_days, eta_max_days,
          is_active, priority)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        shopId(),
        data.name,
        data.zone ?? 'all',
        data.zone_id ?? null,
        data.method ?? 'standard',
        data.rate_type ?? 'flat',
        data.carrier_id ?? null,
        data.min_order_amount ?? 0,
        data.max_order_amount ?? null,
        data.min_weight_grams ?? 0,
        data.max_weight_grams ?? null,
        data.rate,
        data.free_above_amount ?? null,
        data.carrier_markup_percent ?? 0,
        data.carrier_markup_amount ?? 0,
        data.eta_min_days ?? 3,
        data.eta_max_days ?? 7,
        data.is_active !== false ? 1 : 0,
        data.priority ?? 0,
      ],
      exec,
    );
  },

  async updateRate(
    id: number,
    data: Record<string, unknown>,
    exec: Executor = pool,
  ): Promise<void> {
    const allowed = [
      'name', 'zone', 'zone_id', 'method', 'rate_type', 'carrier_id', 'min_order_amount', 'max_order_amount',
      'min_weight_grams', 'max_weight_grams', 'rate', 'free_above_amount',
      'carrier_markup_percent', 'carrier_markup_amount',
      'eta_min_days', 'eta_max_days', 'is_active', 'priority',
    ];
    const sets: string[] = [];
    const params: unknown[] = [];

    for (const key of allowed) {
      if (data[key] !== undefined) {
        sets.push(`\`${key}\` = ?`);
        const val = data[key];
        params.push(typeof val === 'boolean' ? (val ? 1 : 0) : val);
      }
    }

    if (sets.length === 0) return;
    params.push(shopId(), id);
    await execute(`UPDATE shipping_rates SET ${sets.join(', ')} WHERE shop_id = ? AND id = ?`, params, exec);
  },

  async deleteRate(id: number, exec: Executor = pool): Promise<void> {
    await execute('DELETE FROM shipping_rates WHERE shop_id = ? AND id = ?', [shopId(), id], exec);
  },

  // ── Carriers ─────────────────────────────────────────────────────────────

  async listCarriers(exec: Executor = pool): Promise<ShippingCarrierRow[]> {
    return query<ShippingCarrierRow>(
      `SELECT * FROM shipping_carriers WHERE shop_id = ? ORDER BY priority ASC, id ASC`,
      [shopId()],
      exec,
    );
  },

  async findCarrierById(id: number, exec: Executor = pool): Promise<ShippingCarrierRow | null> {
    return queryOne<ShippingCarrierRow>(
      `SELECT * FROM shipping_carriers WHERE shop_id = ? AND id = ? LIMIT 1`,
      [shopId(), id],
      exec,
    );
  },

  async updateCarrier(
    id: number,
    data: Record<string, unknown>,
    exec: Executor = pool,
  ): Promise<void> {
    const allowed = [
      'name', 'tracking_url_template', 'api_provider', 'supports_cod',
      'supports_reverse_pickup', 'logo_media_id', 'is_active', 'priority',
    ];
    const sets: string[] = [];
    const params: unknown[] = [];

    for (const key of allowed) {
      if (data[key] !== undefined) {
        sets.push(`\`${key}\` = ?`);
        const val = data[key];
        params.push(typeof val === 'boolean' ? (val ? 1 : 0) : val);
      }
    }

    if (sets.length === 0) return;
    params.push(shopId(), id);
    await execute(`UPDATE shipping_carriers SET ${sets.join(', ')} WHERE shop_id = ? AND id = ?`, params, exec);
  },

  // ── COD Rules ────────────────────────────────────────────────────────────

  async listCodRules(exec: Executor = pool): Promise<CodRuleRow[]> {
    return query<CodRuleRow>(
      `SELECT * FROM cod_rules WHERE shop_id = ? ORDER BY priority ASC, id ASC`,
      [shopId()],
      exec,
    );
  },

  async findCodRuleById(id: number, exec: Executor = pool): Promise<CodRuleRow | null> {
    return queryOne<CodRuleRow>(
      `SELECT * FROM cod_rules WHERE shop_id = ? AND id = ? LIMIT 1`,
      [shopId(), id],
      exec,
    );
  },

  async updateCodRule(
    id: number,
    data: Record<string, unknown>,
    exec: Executor = pool,
  ): Promise<void> {
    const allowed = [
      'name', 'is_active', 'min_order_amount', 'max_order_amount', 'cod_fee',
      'prepaid_discount_amount', 'prepaid_discount_percent', 'requires_otp_confirmation',
      'max_open_cod_orders', 'block_if_rto_count_gte', 'priority',
    ];
    const sets: string[] = [];
    const params: unknown[] = [];

    for (const key of allowed) {
      if (data[key] !== undefined) {
        sets.push(`\`${key}\` = ?`);
        const val = data[key];
        params.push(typeof val === 'boolean' ? (val ? 1 : 0) : val);
      }
    }

    if (sets.length === 0) return;
    params.push(shopId(), id);
    await execute(`UPDATE cod_rules SET ${sets.join(', ')} WHERE shop_id = ? AND id = ?`, params, exec);
  },

  // ── Pincode Serviceability ───────────────────────────────────────────────

  async lookupPincode(pincode: string, exec: Executor = pool): Promise<PincodeServiceabilityRow | null> {
    return queryOne<PincodeServiceabilityRow>(
      `SELECT ps.*, sc.name AS default_carrier_name
         FROM pincode_serviceability ps
         LEFT JOIN shipping_carriers sc ON sc.id = ps.default_carrier_id AND sc.shop_id = ps.shop_id
        WHERE ps.shop_id = ? AND ps.pincode = ?
        LIMIT 1`,
      [shopId(), pincode],
      exec,
    );
  },

  async upsertPincode(
    data: {
      pincode: string;
      city?: string | null;
      district?: string | null;
      state?: string | null;
      state_code?: string | null;
      zone?: string;
      is_serviceable?: boolean;
      prepaid_available?: boolean;
      cod_available?: boolean;
      express_available?: boolean;
      standard_eta_min_days?: number;
      standard_eta_max_days?: number;
      express_eta_days?: number | null;
      default_carrier_id?: number | null;
      notes?: string | null;
    },
    exec: Executor = pool,
  ): Promise<void> {
    await execute(
      `INSERT INTO pincode_serviceability
         (shop_id, pincode, city, district, state, state_code, zone, is_serviceable,
          prepaid_available, cod_available, express_available, standard_eta_min_days,
          standard_eta_max_days, express_eta_days, default_carrier_id, notes)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE
         city = COALESCE(VALUES(city), city),
         district = COALESCE(VALUES(district), district),
         state = COALESCE(VALUES(state), state),
         state_code = COALESCE(VALUES(state_code), state_code),
         zone = VALUES(zone),
         is_serviceable = VALUES(is_serviceable),
         prepaid_available = VALUES(prepaid_available),
         cod_available = VALUES(cod_available),
         express_available = VALUES(express_available),
         standard_eta_min_days = VALUES(standard_eta_min_days),
         standard_eta_max_days = VALUES(standard_eta_max_days),
         express_eta_days = VALUES(express_eta_days),
         default_carrier_id = VALUES(default_carrier_id),
         notes = VALUES(notes)`,
      [
        shopId(),
        data.pincode,
        data.city ?? null,
        data.district ?? null,
        data.state ?? null,
        data.state_code ?? null,
        data.zone ?? 'rest_of_india',
        data.is_serviceable !== false ? 1 : 0,
        data.prepaid_available !== false ? 1 : 0,
        data.cod_available !== false ? 1 : 0,
        data.express_available ? 1 : 0,
        data.standard_eta_min_days ?? 3,
        data.standard_eta_max_days ?? 7,
        data.express_eta_days ?? null,
        data.default_carrier_id ?? null,
        data.notes ?? null,
      ],
      exec,
    );
  },
};
