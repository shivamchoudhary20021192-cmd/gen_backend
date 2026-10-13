import type { PoolConnection, ResultSetHeader, RowDataPacket } from 'mysql2/promise';
import { pool } from '../../db/pool';
import { shopId } from '../../platform/tenancy/context';

// ============================================================================
// TYPES
// ============================================================================

export interface LookupCategory extends RowDataPacket {
  id: number;
  code: string;
  name: string;
  description: string | null;
  is_active: boolean;
  allow_custom: boolean;
  sort_order: number;
  created_at: string;
  updated_at: string;
}

export interface LookupValue extends RowDataPacket {
  id: number;
  category_id: number;
  code: string;
  label: string;
  description: string | null;
  icon: string | null;
  color: string | null;
  metadata: Record<string, any> | null;
  is_active: boolean;
  sort_order: number;
  created_at: string;
  updated_at: string;
}

export interface LookupValueWithCategory extends LookupValue {
  category_code: string;
  category_name: string;
}

// ============================================================================
// REPOSITORY
// ============================================================================

export class LookupsRepository {
  /**
   * Get all active lookup categories
   */
  static async getCategories(conn?: PoolConnection): Promise<LookupCategory[]> {
    const db = conn || pool;
    const [rows] = await db.query<LookupCategory[]>(
      `SELECT * FROM lookup_categories
       WHERE shop_id = ? AND is_active = TRUE
       ORDER BY sort_order, name`,
      [shopId()],
    );
    return rows;
  }

  /**
   * Get a single category by code
   */
  static async getCategoryByCode(
    code: string,
    conn?: PoolConnection,
  ): Promise<LookupCategory | null> {
    const db = conn || pool;
    const [rows] = await db.query<LookupCategory[]>(
      `SELECT * FROM lookup_categories WHERE shop_id = ? AND code = ? LIMIT 1`,
      [shopId(), code],
    );
    return rows[0] || null;
  }

  /**
   * Get lookup values by category code
   */
  static async getValuesByCategory(
    categoryCode: string,
    conn?: PoolConnection,
  ): Promise<LookupValue[]> {
    const db = conn || pool;
    const [rows] = await db.query<LookupValue[]>(
      `SELECT lv.*
       FROM lookup_values lv
       INNER JOIN lookup_categories lc ON lv.category_id = lc.id
       WHERE lc.shop_id = ? AND lc.code = ? AND lc.is_active = TRUE AND lv.is_active = TRUE
       ORDER BY lv.sort_order, lv.label`,
      [shopId(), categoryCode],
    );
    return rows;
  }

  /**
   * Get all lookup values with their category info (for bulk loading)
   */
  static async getAllValues(conn?: PoolConnection): Promise<LookupValueWithCategory[]> {
    const db = conn || pool;
    const [rows] = await db.query<LookupValueWithCategory[]>(
      `SELECT
         lv.*,
         lc.code AS category_code,
         lc.name AS category_name
       FROM lookup_values lv
       INNER JOIN lookup_categories lc ON lv.category_id = lc.id
       WHERE lc.shop_id = ? AND lc.is_active = TRUE AND lv.is_active = TRUE
       ORDER BY lc.sort_order, lc.name, lv.sort_order, lv.label`,
      [shopId()],
    );
    return rows;
  }

  /**
   * Get multiple categories with their values in one query
   */
  static async getMultipleCategoriesWithValues(
    categoryCodes: string[],
    conn?: PoolConnection,
  ): Promise<Record<string, LookupValue[]>> {
    const db = conn || pool;
    const [rows] = await db.query<LookupValueWithCategory[]>(
      `SELECT
         lv.*,
         lc.code AS category_code
       FROM lookup_values lv
       INNER JOIN lookup_categories lc ON lv.category_id = lc.id
       WHERE lc.shop_id = ? AND lc.code IN (?) AND lc.is_active = TRUE AND lv.is_active = TRUE
       ORDER BY lc.sort_order, lv.sort_order, lv.label`,
      [shopId(), categoryCodes],
    );

    // Group by category code
    const result: Record<string, LookupValue[]> = {};
    for (const row of rows) {
      const categoryCode = row.category_code;
      if (!result[categoryCode]) {
        result[categoryCode] = [];
      }
      result[categoryCode].push(row);
    }

    return result;
  }

  /**
   * Search lookup values across all categories
   */
  static async searchValues(
    query: string,
    categoryCode?: string,
    conn?: PoolConnection,
  ): Promise<LookupValueWithCategory[]> {
    const db = conn || pool;
    const searchPattern = `%${query}%`;

    let sql = `
      SELECT
        lv.*,
        lc.code AS category_code,
        lc.name AS category_name
      FROM lookup_values lv
      INNER JOIN lookup_categories lc ON lv.category_id = lc.id
      WHERE lc.shop_id = ? AND lc.is_active = TRUE AND lv.is_active = TRUE
        AND (lv.label LIKE ? OR lv.code LIKE ? OR lv.description LIKE ?)
    `;

    const params: any[] = [shopId(), searchPattern, searchPattern, searchPattern];

    if (categoryCode) {
      sql += ` AND lc.code = ?`;
      params.push(categoryCode);
    }

    sql += ` ORDER BY lv.label LIMIT 50`;

    const [rows] = await db.query<LookupValueWithCategory[]>(sql, params);
    return rows;
  }

  // ============================================================================
  // ADMIN CRUD OPERATIONS
  // ============================================================================

  /**
   * Create a new lookup category
   */
  static async createCategory(
    data: {
      code: string;
      name: string;
      description?: string | null;
      allow_custom?: boolean;
      sort_order?: number;
    },
    conn?: PoolConnection,
  ): Promise<number> {
    const db = conn || pool;
    const [result] = await db.query<ResultSetHeader>(
      `INSERT INTO lookup_categories (shop_id, code, name, description, allow_custom, sort_order)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [
        shopId(),
        data.code,
        data.name,
        data.description || null,
        data.allow_custom || false,
        data.sort_order || 0,
      ],
    );
    return result.insertId;
  }

  /**
   * Update a lookup category
   */
  static async updateCategory(
    id: number,
    data: {
      name?: string;
      description?: string | null;
      allow_custom?: boolean;
      is_active?: boolean;
      sort_order?: number;
    },
    conn?: PoolConnection,
  ): Promise<void> {
    const db = conn || pool;
    const updates: string[] = [];
    const params: any[] = [];

    if (data.name !== undefined) {
      updates.push('name = ?');
      params.push(data.name);
    }
    if (data.description !== undefined) {
      updates.push('description = ?');
      params.push(data.description);
    }
    if (data.allow_custom !== undefined) {
      updates.push('allow_custom = ?');
      params.push(data.allow_custom);
    }
    if (data.is_active !== undefined) {
      updates.push('is_active = ?');
      params.push(data.is_active);
    }
    if (data.sort_order !== undefined) {
      updates.push('sort_order = ?');
      params.push(data.sort_order);
    }

    if (updates.length === 0) return;

    params.push(shopId(), id);
    await db.query(`UPDATE lookup_categories SET ${updates.join(', ')} WHERE shop_id = ? AND id = ?`, params);
  }

  /**
   * Create a new lookup value
   */
  static async createValue(
    data: {
      category_id: number;
      code: string;
      label: string;
      description?: string | null;
      icon?: string | null;
      color?: string | null;
      metadata?: Record<string, any> | null;
      sort_order?: number;
    },
    conn?: PoolConnection,
  ): Promise<number> {
    const db = conn || pool;
    const [result] = await db.query<ResultSetHeader>(
      `INSERT INTO lookup_values
       (shop_id, category_id, code, label, description, icon, color, metadata, sort_order)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        shopId(),
        data.category_id,
        data.code,
        data.label,
        data.description || null,
        data.icon || null,
        data.color || null,
        data.metadata ? JSON.stringify(data.metadata) : null,
        data.sort_order || 0,
      ],
    );
    return result.insertId;
  }

  /**
   * Update a lookup value
   */
  static async updateValue(
    id: number,
    data: {
      label?: string;
      description?: string | null;
      icon?: string | null;
      color?: string | null;
      metadata?: Record<string, any> | null;
      is_active?: boolean;
      sort_order?: number;
    },
    conn?: PoolConnection,
  ): Promise<void> {
    const db = conn || pool;
    const updates: string[] = [];
    const params: any[] = [];

    if (data.label !== undefined) {
      updates.push('label = ?');
      params.push(data.label);
    }
    if (data.description !== undefined) {
      updates.push('description = ?');
      params.push(data.description);
    }
    if (data.icon !== undefined) {
      updates.push('icon = ?');
      params.push(data.icon);
    }
    if (data.color !== undefined) {
      updates.push('color = ?');
      params.push(data.color);
    }
    if (data.metadata !== undefined) {
      updates.push('metadata = ?');
      params.push(data.metadata ? JSON.stringify(data.metadata) : null);
    }
    if (data.is_active !== undefined) {
      updates.push('is_active = ?');
      params.push(data.is_active);
    }
    if (data.sort_order !== undefined) {
      updates.push('sort_order = ?');
      params.push(data.sort_order);
    }

    if (updates.length === 0) return;

    params.push(shopId(), id);
    await db.query(`UPDATE lookup_values SET ${updates.join(', ')} WHERE shop_id = ? AND id = ?`, params);
  }

  /**
   * Delete a lookup value (soft delete by setting is_active = false)
   */
  static async deleteValue(id: number, conn?: PoolConnection): Promise<void> {
    const db = conn || pool;
    await db.query(`UPDATE lookup_values SET is_active = FALSE WHERE shop_id = ? AND id = ?`, [shopId(), id]);
  }

  /**
   * Reorder lookup values within a category
   */
  static async reorderValues(
    categoryId: number,
    orderedIds: number[],
    conn?: PoolConnection,
  ): Promise<void> {
    const db = conn || pool;

    // Update sort_order for each value
    for (let i = 0; i < orderedIds.length; i++) {
      await db.query(
        `UPDATE lookup_values
         SET sort_order = ?
         WHERE shop_id = ? AND id = ? AND category_id = ?`,
        [i, shopId(), orderedIds[i], categoryId],
      );
    }
  }
}
