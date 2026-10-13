import { ApiError } from '../../core/ApiError';
import { buildMeta, parsePagination, parseSort, type PaginationMeta } from '../../core/pagination';
import { withTransaction } from '../../db/transaction';
import { auditService } from '../../shared/audit.service';
import type { AuthenticatedAdmin } from '../auth/auth.types';
import {
  customersRepository,
  type CustomerAddressRow,
  type CustomerConsentRow,
  type CustomerNoteRow,
  type CustomerRow,
} from './customers.repository';

const SORTABLE: Record<string, string> = {
  created_at: 'c.created_at',
  last_order_at: 'c.last_order_at',
  orders_count: 'c.orders_count',
  total_spent: 'c.total_spent',
  name: 'c.first_name',
};

/** Columns the API may write. Anything else in the body is ignored. */
const UPDATABLE: Record<string, string> = {
  email: 'email',
  first_name: 'first_name',
  last_name: 'last_name',
  gender: 'gender',
  date_of_birth: 'date_of_birth',
  skin_type_id: 'skin_type_id',
  primary_concern_id: 'primary_concern_id',
  preferred_language: 'preferred_language',
  accepts_email_marketing: 'accepts_email_marketing',
  accepts_sms_marketing: 'accepts_sms_marketing',
  accepts_whatsapp_marketing: 'accepts_whatsapp_marketing',
  cod_blocked: 'cod_blocked',
};

interface ActorMeta {
  ip: string | null;
  userAgent: string | null;
  requestId: string;
}

/**
 * Phone numbers are masked in list responses.
 *
 * A staff member scanning a customer list does not need every number in full,
 * and an admin screen is exactly the sort of place a screenshot leaks from. The
 * detail view — one deliberate click, one audit-able read — shows the whole
 * thing.
 */
function maskPhone(phone: string): string {
  if (phone.length <= 4) return phone;
  return `${'•'.repeat(phone.length - 4)}${phone.slice(-4)}`;
}

function maskEmail(email: string | null): string | null {
  if (!email) return null;
  const [name, domain] = email.split('@');
  if (!domain) return email;
  const head = name.slice(0, 2);
  return `${head}${'•'.repeat(Math.max(1, name.length - 2))}@${domain}`;
}

function fullName(row: CustomerRow): string {
  return [row.first_name, row.last_name].filter(Boolean).join(' ') || 'Guest';
}

function present(row: CustomerRow, options: { unmask?: boolean } = {}) {
  return {
    id: row.id,
    public_id: row.public_id,
    name: fullName(row),
    first_name: row.first_name,
    last_name: row.last_name,
    country_code: row.country_code,
    phone: options.unmask ? row.phone : maskPhone(row.phone),
    email: options.unmask ? row.email : maskEmail(row.email),
    gender: row.gender,
    date_of_birth: row.date_of_birth ? row.date_of_birth.toISOString().slice(0, 10) : null,
    status: row.status,
    phone_verified: row.phone_verified_at !== null,
    email_verified: row.email_verified_at !== null,
    marketing: {
      email: row.accepts_email_marketing === 1,
      sms: row.accepts_sms_marketing === 1,
      whatsapp: row.accepts_whatsapp_marketing === 1,
    },
    skin_type_id: row.skin_type_id,
    primary_concern_id: row.primary_concern_id,
    stats: {
      orders_count: row.orders_count,
      total_spent: Number(row.total_spent),
      average_order_value: Number(row.average_order_value),
      last_order_at: row.last_order_at ? row.last_order_at.toISOString() : null,
      rto_count: row.rto_count,
    },
    cod_blocked: row.cod_blocked === 1,
    signup_source: row.signup_source,
    last_seen_at: row.last_seen_at ? row.last_seen_at.toISOString() : null,
    created_at: row.created_at.toISOString(),
  };
}

function presentAddress(row: CustomerAddressRow) {
  return {
    id: row.id,
    label: row.label,
    address_type: row.address_type,
    name: [row.first_name, row.last_name].filter(Boolean).join(' '),
    phone: row.phone,
    line1: row.line1,
    line2: row.line2,
    landmark: row.landmark,
    city: row.city,
    state: row.state,
    state_code: row.state_code,
    pincode: row.pincode,
    country: row.country,
    is_default_shipping: row.is_default_shipping === 1,
    is_default_billing: row.is_default_billing === 1,
    is_verified: row.is_verified === 1,
    delivery_notes: row.delivery_notes,
  };
}

function presentNote(row: CustomerNoteRow) {
  return {
    id: row.id,
    note: row.note,
    is_pinned: row.is_pinned === 1,
    author: row.author_name?.trim() || 'System',
    created_at: row.created_at.toISOString(),
  };
}

function presentConsent(row: CustomerConsentRow) {
  return {
    purpose: row.purpose,
    status: row.status,
    source: row.source,
    notice_version: row.notice_version,
    recorded_at: row.created_at.toISOString(),
  };
}

export const customersService = {
  async list(queryParams: Record<string, unknown>): Promise<{ customers: unknown[]; pagination: PaginationMeta }> {
    const page = parsePagination(queryParams);
    const orderBy = parseSort(queryParams.sort, SORTABLE, 'c.created_at DESC');
    const filters = {
      search: queryParams.q as string | undefined,
      status: queryParams.status as string | undefined,
      codBlocked: queryParams.cod_blocked as boolean | undefined,
      marketing: queryParams.marketing as 'email' | 'sms' | 'whatsapp' | undefined,
      hasOrders: queryParams.has_orders as boolean | undefined,
    };

    const [rows, total] = await Promise.all([
      customersRepository.list(filters, orderBy, page.limit, page.offset),
      customersRepository.count(filters),
    ]);

    return { customers: rows.map((row) => present(row)), pagination: buildMeta(total, page) };
  },

  async get(id: number) {
    const row = await customersRepository.findById(id);
    if (!row || row.deleted_at) throw ApiError.notFound('Customer');

    const [addresses, notes, consents] = await Promise.all([
      customersRepository.addresses(id),
      customersRepository.notes(id),
      customersRepository.consents(id),
    ]);

    return {
      customer: {
        ...present(row, { unmask: true }),
        addresses: addresses.map(presentAddress),
        notes: notes.map(presentNote),
        consents: consents.map(presentConsent),
      },
    };
  },

  async update(id: number, input: Record<string, unknown>, actor: AuthenticatedAdmin, meta: ActorMeta) {
    const existing = await customersRepository.findById(id);
    if (!existing || existing.deleted_at) throw ApiError.notFound('Customer');

    const fields: Record<string, unknown> = {};
    for (const [key, column] of Object.entries(UPDATABLE)) {
      if (!(key in input)) continue;
      const value = input[key];
      fields[column] = typeof value === 'boolean' ? (value ? 1 : 0) : (value ?? null);
    }

    if (typeof fields.email === 'string' && fields.email !== existing.email) {
      if (await customersRepository.emailTaken(fields.email, id)) {
        throw ApiError.conflict('Another customer already uses that email address.', 'EMAIL_TAKEN');
      }
      // Changing the address invalidates the proof that they own it.
      fields.email_verified_at = null;
    }

    if (Object.keys(fields).length === 0) {
      throw ApiError.validation({ customer: ['Provide at least one field to update.'] });
    }

    await withTransaction(async (tx) => {
      await customersRepository.update(id, fields, tx);
      await auditService.log(
        {
          actorId: actor.id,
          actorLabel: actor.email,
          action: 'customer.updated',
          entityType: 'customer',
          entityId: id,
          summary: `Updated customer ${fullName(existing)}`,
          changes: auditService.diff(existing as unknown as Record<string, unknown>, fields),
          context: { request_id: meta.requestId },
          ip: meta.ip,
          userAgent: meta.userAgent,
        },
        tx,
      );
    });

    return this.get(id);
  },

  /**
   * Blocking is reversible and stops them signing in; it does not touch their
   * orders, which still need fulfilling or refunding either way.
   */
  async setStatus(
    id: number,
    status: 'active' | 'blocked',
    reason: string | null,
    actor: AuthenticatedAdmin,
    meta: ActorMeta,
  ) {
    const existing = await customersRepository.findById(id);
    if (!existing || existing.deleted_at) throw ApiError.notFound('Customer');
    if (existing.status === status) return this.get(id);

    await withTransaction(async (tx) => {
      await customersRepository.update(id, { status }, tx);
      if (status === 'blocked') await customersRepository.revokeSessions(id, tx);
      await auditService.log(
        {
          actorId: actor.id,
          actorLabel: actor.email,
          action: status === 'blocked' ? 'customer.blocked' : 'customer.unblocked',
          entityType: 'customer',
          entityId: id,
          summary:
            status === 'blocked'
              ? `Blocked ${fullName(existing)}${reason ? `: ${reason}` : ''}`
              : `Unblocked ${fullName(existing)}`,
          context: { request_id: meta.requestId, reason },
          ip: meta.ip,
          userAgent: meta.userAgent,
        },
        tx,
      );
    });

    return this.get(id);
  },

  async addNote(id: number, note: string, isPinned: boolean, actor: AuthenticatedAdmin) {
    const existing = await customersRepository.findById(id);
    if (!existing || existing.deleted_at) throw ApiError.notFound('Customer');
    await customersRepository.addNote(id, actor.id, note, isPinned);
    const notes = await customersRepository.notes(id);
    return { notes: notes.map(presentNote) };
  },

  async removeNote(id: number, noteId: number) {
    const removed = await customersRepository.deleteNote(id, noteId);
    if (removed === 0) throw ApiError.notFound('Note');
    const notes = await customersRepository.notes(id);
    return { notes: notes.map(presentNote) };
  },

  /**
   * Soft delete, and only that.
   *
   * A hard delete would orphan orders and break the invoice trail India's GST
   * rules require you to keep. `anonymised_at` plus a scrubbing job is the
   * right answer to a real erasure request; this is the reversible half.
   */
  async remove(id: number, actor: AuthenticatedAdmin, meta: ActorMeta) {
    const existing = await customersRepository.findById(id);
    if (!existing || existing.deleted_at) throw ApiError.notFound('Customer');

    await withTransaction(async (tx) => {
      await customersRepository.update(id, { deleted_at: new Date(), status: 'deleted' }, tx);
      await auditService.log(
        {
          actorId: actor.id,
          actorLabel: actor.email,
          action: 'customer.deleted',
          entityType: 'customer',
          entityId: id,
          summary: `Soft-deleted customer ${fullName(existing)}`,
          context: { request_id: meta.requestId },
          ip: meta.ip,
          userAgent: meta.userAgent,
        },
        tx,
      );
    });
  },
};
