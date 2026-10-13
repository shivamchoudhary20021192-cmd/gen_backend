import type { AuthenticatedAdmin, AuthenticatedIdentity } from '../../modules/auth/auth.types';
import type { SignedInCustomer } from '../../middleware/authenticateCustomer';
import type { ShopContext } from '../../platform/tenancy/context';

declare global {
  namespace Express {
    interface Request {
      /** Set by requestContext middleware, echoed as X-Request-Id. */
      requestId: string;
      /**
       * The shop this request acts on. Set by the storefront resolver from the
       * host, or by `authenticate` from the staff member's chosen shop or the
       * app's installation. Absent on platform routes.
       */
      shop?: ShopContext;
      /** Set by authenticate middleware. Absent on public routes. */
      admin?: AuthenticatedAdmin;
      /** The signed-in person, set even when they have no shop to act in yet. */
      identity?: AuthenticatedIdentity;
      /**
       * Set by withCustomer / requireCustomer on the storefront.
       *
       * Separate from `admin` on purpose: the two token families have different
       * issuers, so neither can ever be presented as the other.
       */
      customer?: SignedInCustomer;
      /** The negotiated Admin API version, e.g. "2026-10". */
      apiVersion?: string;
      /** Raw request bytes, kept only for routes that verify a signature over them. */
      rawBody?: Buffer;
      /** Set once an app request has been counted against its API bucket. */
      apiCallMetered?: boolean;
    }
  }
}

export {};
