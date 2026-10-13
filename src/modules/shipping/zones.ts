import { ApiError } from '../../core/ApiError';
import { execute, insert, pool, query, queryOne, type Executor, type RowDataPacket } from '../../db/pool';
import { withTransaction } from '../../db/transaction';
import { knowsRegionsOf, regionCodeFor } from '../../platform/geo/regions';
import { shopId, tenancy } from '../../platform/tenancy/context';
import { auditService } from '../../shared/audit.service';
import type { AuthenticatedAdmin } from '../auth/auth.types';
import { normalisePostal, shippingQuote } from './shippingQuote';

/**
 * Settings → Shipping → Zones: named sets of states and postcode prefixes
 * inside the store's country, each with its own rates.
 */

interface ZoneRow extends RowDataPacket {
  id: number;
  name: string;
  is_active: number;
}

interface AreaRow extends RowDataPacket {
  id: number;
  zone_id: number;
  country_code: string;
  region_code: string | null;
  postal_prefix: string | null;
}

interface ActorMeta {
  ip: string | null;
  userAgent: string | null;
}

export interface AreaInput {
  /** Two-letter country; omitted, the store's own. */
  country?: string | null;
  region?: string | null;
  postal_prefix?: string | null;
}

interface Place {
  country: string;
  region: string | null;
  prefix: string | null;
}

const zonesRepository = {
  async zones(exec: Executor = pool): Promise<ZoneRow[]> {
    return query<ZoneRow>('SELECT id, name, is_active FROM shipping_zones WHERE shop_id = ? ORDER BY name', [shopId()], exec);
  },

  async zone(id: number, exec: Executor = pool): Promise<ZoneRow | null> {
    return queryOne<ZoneRow>('SELECT id, name, is_active FROM shipping_zones WHERE shop_id = ? AND id = ?', [shopId(), id], exec);
  },

  async areas(exec: Executor = pool): Promise<AreaRow[]> {
    return query<AreaRow>(
      'SELECT id, zone_id, country_code, region_code, postal_prefix FROM shipping_zone_areas WHERE shop_id = ? ORDER BY country_code, region_code, postal_prefix',
      [shopId()],
      exec,
    );
  },

  async rateCounts(exec: Executor = pool): Promise<Map<number, number>> {
    const rows = await query<RowDataPacket & { zone_id: number; total: number }>(
      'SELECT zone_id, COUNT(*) AS total FROM shipping_rates WHERE shop_id = ? AND zone_id IS NOT NULL GROUP BY zone_id',
      [shopId()],
      exec,
    );
    return new Map(rows.map((row) => [Number(row.zone_id), Number(row.total)]));
  },

  async replaceAreas(zoneId: number, areas: Place[], exec: Executor): Promise<void> {
    await execute('DELETE FROM shipping_zone_areas WHERE shop_id = ? AND zone_id = ?', [shopId(), zoneId], exec);
    for (const area of areas) {
      await execute(
        'INSERT INTO shipping_zone_areas (shop_id, zone_id, country_code, region_code, postal_prefix) VALUES (?, ?, ?, ?, ?)',
        [shopId(), zoneId, area.country, area.region, area.prefix],
        exec,
      );
    }
  },

  /** Which zone already claims a place, for a useful conflict message. */
  async owner(place: Place, exceptZoneId: number | null, exec: Executor): Promise<string | null> {
    const row = await queryOne<RowDataPacket & { name: string }>(
      `SELECT z.name FROM shipping_zone_areas a JOIN shipping_zones z ON z.id = a.zone_id AND z.shop_id = a.shop_id
        WHERE a.shop_id = ? AND a.country_code = ? AND a.region_code <=> ? AND a.postal_prefix <=> ? AND (? IS NULL OR a.zone_id <> ?) LIMIT 1`,
      [shopId(), place.country, place.region, place.prefix, exceptZoneId, exceptZoneId],
      exec,
    );
    return row?.name ?? null;
  },
};

/** Areas as the merchant typed them, checked and normalised. */
function normaliseAreas(input: AreaInput[]): Place[] {
  const home = tenancy.current().countryCode;
  const seen = new Set<string>();
  const out: Place[] = [];
  input.forEach((area, index) => {
    const country = (area.country ?? home).trim().toUpperCase();
    if (!/^[A-Z]{2}$/.test(country)) throw ApiError.validation({ [`zone.areas.${index}.country`]: ['Use a two-letter country code.'] });
    let region: string | null = null;
    if (area.region) {
      region = knowsRegionsOf(country) ? regionCodeFor(country, area.region) : area.region.trim().toUpperCase();
      if (!region) throw ApiError.validation({ [`zone.areas.${index}.region`]: [`"${area.region}" is not a state or province we recognise.`] });
    }
    const prefix = normalisePostal(area.postal_prefix);
    if (prefix !== null && !/^[A-Z0-9][A-Z0-9 -]{0,9}$/.test(prefix)) {
      throw ApiError.validation({ [`zone.areas.${index}.postal_prefix`]: ['Use the start of a postcode: letters and digits, up to 10.'] });
    }
    // At home a zone is part of the country; abroad a whole country is a place.
    if (!region && !prefix && country === home) throw ApiError.validation({ [`zone.areas.${index}`]: ['Give a state, a postcode prefix, or both.'] });
    const key = `${country}:${region ?? '*'}:${prefix ?? '*'}`;
    if (!seen.has(key)) {
      seen.add(key);
      out.push({ country, region, prefix });
    }
  });
  if (out.length === 0) throw ApiError.validation({ 'zone.areas': ['A zone needs at least one place.'] });
  return out;
}

async function assertAreasFree(areas: Place[], zoneId: number | null, exec: Executor): Promise<void> {
  for (const area of areas) {
    const owner = await zonesRepository.owner(area, zoneId, exec);
    if (owner) {
      const place = [area.region ?? (area.prefix ? null : area.country), area.prefix ? `postcodes ${area.prefix}…` : null].filter(Boolean).join(', ');
      throw ApiError.conflict(`${place} is already in the zone "${owner}". A place can be in one zone.`);
    }
  }
}

function isDuplicateName(error: unknown): boolean {
  return (error as { code?: string }).code === 'ER_DUP_ENTRY';
}

export const shippingZonesService = {
  async list() {
    const [zones, areas, counts] = await Promise.all([zonesRepository.zones(), zonesRepository.areas(), zonesRepository.rateCounts()]);
    return {
      zones: zones.map((zone) => ({
        id: zone.id,
        name: zone.name,
        is_active: zone.is_active === 1,
        areas: areas
          .filter((area) => Number(area.zone_id) === zone.id)
          .map((area) => ({ country: area.country_code, region: area.region_code, postal_prefix: area.postal_prefix })),
        rate_count: counts.get(zone.id) ?? 0,
      })),
    };
  },

  async create(input: { name: string; is_active?: boolean; areas: AreaInput[] }, admin: AuthenticatedAdmin, meta: ActorMeta) {
    const areas = normaliseAreas(input.areas);
    let id: number;
    try {
      id = await withTransaction(async (tx) => {
        await assertAreasFree(areas, null, tx);
        const created = await insert('INSERT INTO shipping_zones (shop_id, name, is_active) VALUES (?, ?, ?)', [shopId(), input.name, input.is_active === false ? 0 : 1], tx);
        await zonesRepository.replaceAreas(created, areas, tx);
        return created;
      });
    } catch (error) {
      if (isDuplicateName(error)) throw ApiError.conflict(`There is already a zone called "${input.name}".`);
      throw error;
    }
    shippingQuote.invalidate();
    await auditService.log({ actorId: admin.id, actorLabel: admin.email, action: 'shipping.zone_created', entityType: 'shipping_zone', entityId: id, summary: `Created shipping zone "${input.name}"`, changes: { areas }, ip: meta.ip, userAgent: meta.userAgent });
    return { zone: (await this.list()).zones.find((zone) => zone.id === id) };
  },

  async update(id: number, input: { name?: string; is_active?: boolean; areas?: AreaInput[] }, admin: AuthenticatedAdmin, meta: ActorMeta) {
    const existing = await zonesRepository.zone(id);
    if (!existing) throw ApiError.notFound('Shipping zone');
    const areas = input.areas ? normaliseAreas(input.areas) : null;
    try {
      await withTransaction(async (tx) => {
        if (input.name !== undefined || input.is_active !== undefined) {
          await execute(
            'UPDATE shipping_zones SET name = COALESCE(?, name), is_active = COALESCE(?, is_active) WHERE shop_id = ? AND id = ?',
            [input.name ?? null, input.is_active === undefined ? null : input.is_active ? 1 : 0, shopId(), id],
            tx,
          );
        }
        if (areas) {
          await assertAreasFree(areas, id, tx);
          await zonesRepository.replaceAreas(id, areas, tx);
        }
      });
    } catch (error) {
      if (isDuplicateName(error)) throw ApiError.conflict(`There is already a zone called "${input.name}".`);
      throw error;
    }
    shippingQuote.invalidate();
    await auditService.log({ actorId: admin.id, actorLabel: admin.email, action: 'shipping.zone_updated', entityType: 'shipping_zone', entityId: id, summary: `Updated shipping zone "${existing.name}"`, changes: input, ip: meta.ip, userAgent: meta.userAgent });
    return { zone: (await this.list()).zones.find((zone) => zone.id === id) };
  },

  /** Deleting a zone deletes its rates: its places go back to the everywhere rates. */
  async remove(id: number, admin: AuthenticatedAdmin, meta: ActorMeta) {
    const existing = await zonesRepository.zone(id);
    if (!existing) throw ApiError.notFound('Shipping zone');
    await execute('DELETE FROM shipping_zones WHERE shop_id = ? AND id = ?', [shopId(), id]);
    shippingQuote.invalidate();
    await auditService.log({ actorId: admin.id, actorLabel: admin.email, action: 'shipping.zone_deleted', entityType: 'shipping_zone', entityId: id, summary: `Deleted shipping zone "${existing.name}"`, ip: meta.ip, userAgent: meta.userAgent });
    return { deleted: true };
  },

  /** For rates: the zone must be this shop's. */
  async assertZone(zoneId: number | null | undefined): Promise<void> {
    if (zoneId === null || zoneId === undefined) return;
    if (!(await zonesRepository.zone(zoneId))) throw ApiError.validation({ zone_id: ['That shipping zone does not exist.'] });
  },

  /** What a customer at an address would be offered, for checking the setup. */
  async preview(input: { country?: string | null; postal_code?: string | null; region?: string | null; subtotal: number; weight_grams: number }) {
    const country = (input.country ?? tenancy.current().countryCode).toUpperCase();
    const region = input.region ? regionCodeFor(country, input.region) ?? input.region.toUpperCase() : null;
    return shippingQuote.quote({ subtotal: input.subtotal, weightGrams: input.weight_grams, postalCode: input.postal_code ?? null, region, country });
  },
};
