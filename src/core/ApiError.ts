export type ErrorCode =
  | 'BAD_REQUEST'
  | 'MALFORMED_JSON'
  | 'UNAUTHENTICATED'
  | 'TOKEN_EXPIRED'
  | 'SESSION_REVOKED'
  | 'INVALID_CREDENTIALS'
  | 'ACCOUNT_LOCKED'
  | 'ACCOUNT_INACTIVE'
  | 'MFA_REQUIRED'
  | 'INVALID_MFA_CODE'
  | 'MFA_CHALLENGE_INVALID'
  | 'MFA_ALREADY_ENABLED'
  | 'MFA_NOT_ENABLED'
  | 'MFA_SETUP_REQUIRED'
  | 'FORBIDDEN'
  | 'NOT_FOUND'
  | 'CONFLICT'
  | 'SLUG_TAKEN'
  | 'SKU_TAKEN'
  | 'EMAIL_TAKEN'
  | 'IN_USE'
  // Theme files: saved by someone else since opened; a file every theme needs; a name taken.
  // Products (new): saved by someone else since opened; a product the classic
  // editor may no longer change because Products (new) owns it.
  | 'VERSION_CONFLICT'
  | 'CATALOG_MANAGED'
  | 'STALE_FILE'
  | 'REQUIRED_FILE'
  | 'FILE_EXISTS'
  // A domain connected to another store: it can move here only with proof of ownership.
  | 'DOMAIN_TAKEN'
  // The request was well-formed and permitted, but the entity is not in a state
  // that allows it — a client can use this to refresh the actions it offers,
  // which a bare CONFLICT does not tell it to do.
  | 'INVALID_TRANSITION'
  | 'VALIDATION_FAILED'
  // Content-module refusals. Each names a specific thing the editor got wrong,
  // so the admin can put the cursor in the offending field instead of showing a
  // generic "bad request" over a form with twenty inputs.
  | 'INVALID_DATE_RANGE'
  | 'INVALID_CTA'
  | 'INVALID_COLOR'
  | 'INVALID_OPERATION'
  | 'PAYLOAD_TOO_LARGE'
  | 'UNSUPPORTED_MEDIA_TYPE'
  | 'RATE_LIMITED'
  // A third party we depend on — a courier, a payment gateway — failed or did
  // not answer. Distinct from INTERNAL_ERROR because nothing here is wrong with
  // us or with the request: the same call may well succeed on a retry, and the
  // client should offer that rather than reporting a bug.
  | 'UPSTREAM_UNAVAILABLE'
  // Platform: which shop, and whether it may be served.
  | 'SHOP_NOT_FOUND'
  | 'SHOP_REQUIRED'
  | 'SHOP_UNAVAILABLE'
  | 'NOT_A_MEMBER'
  // Plans: the shop's subscription does not include this, or is at its limit.
  // Distinct so the admin can show an upgrade prompt instead of an error.
  | 'FEATURE_NOT_IN_PLAN'
  | 'PLAN_LIMIT_REACHED'
  // Apps: the access token is valid but was not granted the scope needed.
  | 'INSUFFICIENT_SCOPE'
  // Integrations: the shop has not connected a provider for this capability.
  | 'INTEGRATION_NOT_CONFIGURED'
  // Checkout: the basket changed meaning between the bag and the order. Each
  // tells the storefront which part of the form to send the shopper back to.
  | 'UNDELIVERABLE'
  | 'SHIPPING_METHOD_UNAVAILABLE'
  | 'COD_UNAVAILABLE'
  | 'DISCOUNT_NOT_APPLICABLE'
  | 'GIFT_CARD_NOT_APPLICABLE'
  | 'INTERNAL_ERROR';

export type FieldErrors = Record<string, string[]>;

/**
 * The only error type a service is allowed to throw. Everything else that
 * escapes is treated as a bug and becomes a 500 with the stack logged but
 * never returned.
 */
export class ApiError extends Error {
  readonly status: number;
  readonly code: ErrorCode;
  readonly details?: FieldErrors | Record<string, unknown>;
  readonly retryAfterSeconds?: number;

  constructor(
    status: number,
    code: ErrorCode,
    message: string,
    details?: FieldErrors | Record<string, unknown>,
    retryAfterSeconds?: number,
  ) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
    this.details = details;
    this.retryAfterSeconds = retryAfterSeconds;
    Error.captureStackTrace?.(this, ApiError);
  }

  static badRequest(message = 'The request could not be understood.', details?: FieldErrors) {
    return new ApiError(400, 'BAD_REQUEST', message, details);
  }

  static unauthenticated(message = 'Authentication is required.', code: ErrorCode = 'UNAUTHENTICATED') {
    return new ApiError(401, code, message);
  }

  static forbidden(message = 'You do not have permission to perform this action.', details?: Record<string, unknown>) {
    return new ApiError(403, 'FORBIDDEN', message, details);
  }

  static notFound(resource = 'Resource') {
    return new ApiError(404, 'NOT_FOUND', `${resource} was not found.`);
  }

  static conflict(message: string, code: ErrorCode = 'CONFLICT', details?: Record<string, unknown>) {
    return new ApiError(409, code, message, details);
  }

  static validation(details: FieldErrors, message = 'The request body is invalid.') {
    return new ApiError(422, 'VALIDATION_FAILED', message, details);
  }

  static rateLimited(retryAfterSeconds: number, message = 'Too many requests. Please slow down.') {
    return new ApiError(429, 'RATE_LIMITED', message, undefined, retryAfterSeconds);
  }

  /** A courier, gateway or other third party failed or did not respond. */
  static upstream(message: string, details?: Record<string, unknown>) {
    return new ApiError(502, 'UPSTREAM_UNAVAILABLE', message, details);
  }

  static internal(message = 'Something went wrong on our side.') {
    return new ApiError(500, 'INTERNAL_ERROR', message);
  }

  static shopNotFound(message = 'No shop is served at this address.') {
    return new ApiError(404, 'SHOP_NOT_FOUND', message);
  }

  static shopUnavailable(message: string, details?: Record<string, unknown>) {
    return new ApiError(403, 'SHOP_UNAVAILABLE', message, details);
  }

  /** 402: the request is fine, the plan is not. The admin turns this into an upgrade prompt. */
  static featureNotInPlan(feature: string, plan: string | null) {
    return new ApiError(402, 'FEATURE_NOT_IN_PLAN', `Your ${plan ?? 'current'} plan does not include this feature.`, {
      feature,
      plan,
    });
  }

  static planLimit(limit: string, max: number, plan: string | null) {
    return new ApiError(
      402,
      'PLAN_LIMIT_REACHED',
      `You have reached the ${max} ${limit.replace(/_/g, ' ')} included in your ${plan ?? 'current'} plan.`,
      { limit, max, plan },
    );
  }

  static insufficientScope(required: string[]) {
    return new ApiError(403, 'INSUFFICIENT_SCOPE', 'This access token was not granted the scope this call needs.', {
      required_scopes: required,
    });
  }

  static integrationNotConfigured(capability: string, message?: string) {
    return new ApiError(
      409,
      'INTEGRATION_NOT_CONFIGURED',
      message ?? `No ${capability.replace(/[._]/g, ' ')} provider is connected. Connect one in Settings → Integrations.`,
      { capability },
    );
  }
}
