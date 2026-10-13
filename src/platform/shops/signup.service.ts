import bcrypt from 'bcryptjs';
import { env } from '../../config/env';
import { ApiError } from '../../core/ApiError';
import { logger } from '../../core/logger';
import { adminUsersRepository } from '../../modules/admin-users/adminUsers.repository';
import { authService } from '../../modules/auth/auth.service';
import { regionFor } from './blueprints/regions';
import { shopProvisioner, validHandle, type CreateShopInput } from './provisioning';
import { shopsRepository } from './shops.repository';

/**
 * Opening a store.
 *
 * A new merchant signs up once: an identity (their login, which can later own
 * or work in many stores) and their first store are created together, the
 * store is provisioned from its blueprints, and they are signed in — landing
 * in a working admin, not an email-confirmation limbo. Someone who already has
 * an identity signs in and creates further stores from their account instead,
 * so this endpoint cannot be used to attach a new store to somebody else's
 * email address.
 */

interface RequestMeta {
  ip: string | null;
  userAgent: string | null;
  requestId: string;
}

export const signupService = {
  async handleAvailability(handle: string) {
    const value = handle.trim().toLowerCase();
    if (!validHandle(value)) return { handle: value, available: false, reason: 'invalid' as const };
    const taken = await shopsRepository.handleTaken(value);
    return {
      handle: value,
      available: !taken,
      reason: taken ? ('taken' as const) : null,
      storefront_domain: `${value}.${env.platform.storefrontDomain}`,
    };
  },

  async suggestHandle(name: string) {
    return { handle: await shopProvisioner.suggestHandle(name) };
  },

  async signup(
    input: {
      email: string;
      password: string;
      first_name: string;
      last_name?: string | null;
      phone?: string | null;
      shop: CreateShopInput;
    },
    meta: RequestMeta,
  ) {
    if (!env.platform.signupEnabled) {
      throw ApiError.forbidden('New stores cannot be opened on this platform right now.');
    }
    const email = input.email.trim().toLowerCase();
    if (await adminUsersRepository.findIdentityByEmail(email)) {
      throw ApiError.conflict('An account with this email already exists. Sign in to open another store from your account.', 'EMAIL_TAKEN');
    }

    const region = regionFor(input.shop.countryCode, { timezone: input.shop.timezone });
    const identityId = await adminUsersRepository.createIdentity({
      email,
      passwordHash: await bcrypt.hash(input.password, env.auth.bcryptRounds),
      firstName: input.first_name.trim(),
      lastName: input.last_name?.trim() || null,
      phone: input.phone?.trim() || null,
      jobTitle: 'Owner',
      status: 'active',
      mustChangePassword: false,
      timezone: region.timezone,
      createdByAdminId: null,
    });

    const shop = await shopProvisioner.createAndProvision({ ...input.shop, email: input.shop.email ?? email }, identityId);
    logger.info('signup.completed', { shop_id: shop.id, handle: shop.handle, identity_id: identityId });

    // Signs them in exactly as the login screen would: same session, same
    // audit trail, active shop set to the one just created.
    const session = await authService.login(email, input.password, meta);
    return { ...session, shop: { id: shop.publicId, handle: shop.handle, name: shop.name, status: shop.status } };
  },

  /** A signed-in person opening another store. They become its owner. */
  async createAdditionalShop(identityId: number, input: CreateShopInput) {
    const shop = await shopProvisioner.createAndProvision(input, identityId);
    return { shop: { id: shop.publicId, handle: shop.handle, name: shop.name, status: shop.status } };
  },
};
