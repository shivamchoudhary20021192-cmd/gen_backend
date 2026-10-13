import { execute, insert, query, queryOne, pool, type Executor, type RowDataPacket } from '../../db/pool';
import { shopId } from '../../platform/tenancy/context';

export interface TaxClassRow extends RowDataPacket {
  id: number;
  code: string;
  name: string;
  hsn_code: string | null;
  gst_rate: string;
  is_inclusive: number;
  is_exempt: number;
  is_default: number;
  is_active: number;
  product_count?: number;
}

export interface TaxRegistrationRow extends RowDataPacket {
  id: number;
  country_code: string;
  region_code: string | null;
  name: string;
  registration_number: string | null;
  rate: string;
  shipping_taxable: number;
  is_active: number;
  created_at: Date;
}

const CLASS_COLUMNS = ['code', 'name', 'hsn_code', 'gst_rate', 'is_inclusive', 'is_exempt', 'is_active'] as const;
const REGISTRATION_COLUMNS = ['country_code', 'region_code', 'name', 'registration_number', 'rate', 'shipping_taxable', 'is_active'] as const;

function pick<T extends readonly string[]>(columns: T, data: Record<string, unknown>): [string[], unknown[]] {
  const keys = columns.filter((column) => column in data);
  return [keys, keys.map((key) => data[key])];
}

export const taxRepository = {
  async classes(exec: Executor = pool): Promise<TaxClassRow[]> {
    return query<TaxClassRow>(
      `SELECT tc.*,
              (SELECT COUNT(*) FROM products p WHERE p.shop_id = tc.shop_id AND p.tax_class_id = tc.id AND p.deleted_at IS NULL) AS product_count
         FROM tax_classes tc WHERE tc.shop_id = ? ORDER BY tc.is_default DESC, tc.name`,
      [shopId()],
      exec,
    );
  },

  async classById(id: number, exec: Executor = pool): Promise<TaxClassRow | null> {
    return queryOne<TaxClassRow>('SELECT * FROM tax_classes WHERE shop_id = ? AND id = ?', [shopId(), id], exec);
  },

  async createClass(data: Record<string, unknown>, exec: Executor): Promise<number> {
    const [keys, values] = pick(CLASS_COLUMNS, data);
    return insert(
      `INSERT INTO tax_classes (shop_id, ${keys.join(', ')}) VALUES (?, ${keys.map(() => '?').join(', ')})`,
      [shopId(), ...values],
      exec,
    );
  },

  async updateClass(id: number, data: Record<string, unknown>, exec: Executor): Promise<void> {
    const [keys, values] = pick(CLASS_COLUMNS, data);
    if (keys.length === 0) return;
    await execute(`UPDATE tax_classes SET ${keys.map((key) => `${key} = ?`).join(', ')} WHERE shop_id = ? AND id = ?`, [...values, shopId(), id], exec);
  },

  /** Exactly one default class: the one products without a class are taxed by. */
  async makeDefault(id: number, exec: Executor): Promise<void> {
    await execute('UPDATE tax_classes SET is_default = (id = ?) WHERE shop_id = ?', [id, shopId()], exec);
  },

  async registrations(exec: Executor = pool): Promise<TaxRegistrationRow[]> {
    return query<TaxRegistrationRow>(
      'SELECT * FROM tax_registrations WHERE shop_id = ? ORDER BY country_code, region_code IS NOT NULL, region_code',
      [shopId()],
      exec,
    );
  },

  async registrationById(id: number, exec: Executor = pool): Promise<TaxRegistrationRow | null> {
    return queryOne<TaxRegistrationRow>('SELECT * FROM tax_registrations WHERE shop_id = ? AND id = ?', [shopId(), id], exec);
  },

  async createRegistration(data: Record<string, unknown>, exec: Executor = pool): Promise<number> {
    const [keys, values] = pick(REGISTRATION_COLUMNS, data);
    return insert(
      `INSERT INTO tax_registrations (shop_id, ${keys.join(', ')}) VALUES (?, ${keys.map(() => '?').join(', ')})`,
      [shopId(), ...values],
      exec,
    );
  },

  async updateRegistration(id: number, data: Record<string, unknown>, exec: Executor = pool): Promise<void> {
    const [keys, values] = pick(REGISTRATION_COLUMNS, data);
    if (keys.length === 0) return;
    await execute(`UPDATE tax_registrations SET ${keys.map((key) => `${key} = ?`).join(', ')} WHERE shop_id = ? AND id = ?`, [...values, shopId(), id], exec);
  },

  /** What has been reported to the tax service, by kind. */
  async reportSummary(exec: Executor = pool) {
    return query<RowDataPacket & { kind: 'sale' | 'refund'; total: number; last_reported_at: Date | null }>(
      'SELECT kind, COUNT(*) AS total, MAX(reported_at) AS last_reported_at FROM tax_reports WHERE shop_id = ? GROUP BY kind',
      [shopId()],
      exec,
    );
  },

  async deleteRegistration(id: number, exec: Executor = pool): Promise<number> {
    const result = await execute('DELETE FROM tax_registrations WHERE shop_id = ? AND id = ?', [shopId(), id], exec);
    return result.affectedRows;
  },
};
