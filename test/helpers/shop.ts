import type { ShopContext } from '../../src/platform/tenancy/context';

/** A shop context for tests that never touch the database. */
export function fakeShop(overrides: Partial<ShopContext> = {}): ShopContext {
  return {
    id: 1,
    publicId: '00000000-0000-4000-8000-000000000001',
    handle: 'test-shop',
    name: 'Test Shop',
    podId: 1,
    status: 'active',
    planId: 1,
    vertical: 'general',
    countryCode: 'IN',
    currency: 'INR',
    timezone: 'Asia/Kolkata',
    locale: 'en-IN',
    taxEngine: 'in_gst',
    primaryDomain: 'test-shop.myveylog.com',
    storefrontLocked: false,
    ...overrides,
  };
}
