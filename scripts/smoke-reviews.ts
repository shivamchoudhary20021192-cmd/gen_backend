/**
 * End-to-end smoke test for product reviews.
 *
 *   npm run dev        # in one shell
 *   npm run smoke:reviews
 *
 * The gate and the arithmetic are the point:
 *
 *   - only a delivered order containing that product earns a review, and each
 *     refusal says which of the three things went wrong
 *   - a review is invisible until a moderator approves it
 *   - the product's rating figures are derived from approved rows and move the
 *     moment moderation does — no seeded values, no drift between the number on
 *     a card and the rows behind it
 *   - a review that describes a skin reaction is flagged and sorted to the top
 */
import { env } from '../src/config/env';
import { closePool, execute, queryOne, type RowDataPacket } from '../src/db/pool';

const ADMIN = `http://127.0.0.1:${env.port}${env.apiPrefix}`;
const SHOP = `http://127.0.0.1:${env.port}/api/v1`;

let passed = 0;
let failed = 0;
const failures: string[] = [];

function ok(label: string, condition: boolean, detail?: unknown): void {
  if (condition) {
    passed += 1;
    process.stdout.write(`  ✓ ${label}\n`);
  } else {
    failed += 1;
    failures.push(label);
    process.stdout.write(`  ✗ ${label}${detail === undefined ? '' : ` — ${JSON.stringify(detail)}`}\n`);
  }
}

let token = '';

interface Raw<T> {
  status: number;
  body: T;
}

async function raw<T>(base: string, path: string, options: { method?: string; body?: unknown; auth?: boolean } = {}): Promise<Raw<T>> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    'Idempotency-Key': crypto.randomUUID(),
  };
  if (options.auth !== false) headers.Authorization = `Bearer ${token}`;
  const response = await fetch(`${base}${path}`, {
    method: options.method ?? 'GET',
    headers,
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  });
  const text = await response.text();
  return { status: response.status, body: (text ? JSON.parse(text) : null) as T };
}

const admin = <T>(path: string, options: { method?: string; body?: unknown } = {}) => raw<T>(ADMIN, path, options);
const shop = <T>(path: string, options: { method?: string; body?: unknown } = {}) =>
  raw<T>(SHOP, path, { ...options, auth: false });

async function adminOrThrow<T>(path: string, options: { method?: string; body?: unknown } = {}): Promise<T> {
  const result = await admin<T>(path, options);
  if (result.status >= 400) throw new Error(`${path} → ${result.status} ${JSON.stringify(result.body).slice(0, 300)}`);
  return result.body;
}

/** Buys one unit and drives the order all the way to delivered. */
async function deliveredOrder(): Promise<{ orderNumber: string; phone: string; slug: string; orderId: number }> {
  const listed = await shop<{ products: { slug: string }[] }>('/products?limit=1&sort=featured');
  const slug = listed.body.products[0].slug;
  const detail = await shop<{ product: { variants: { id: number; in_stock?: boolean }[] } }>(`/products/${slug}`);
  const variant = detail.body.product.variants.find((v) => v.in_stock) ?? detail.body.product.variants[0];
  const phone = `9${String(Date.now()).slice(-9)}`;

  const cart = await shop<{ cart: { token: string } }>('/cart', { method: 'POST' });
  await shop(`/cart/${cart.body.cart.token}/items`, { method: 'POST', body: { variant_id: variant.id, quantity: 1 } });
  const placed = await shop<{ order: { id: number; order_number: string } }>(
    `/cart/${cart.body.cart.token}/checkout`,
    {
      method: 'POST',
      body: {
        payment_method: 'cod',
        contact: { first_name: 'Review', last_name: 'Tester', phone, email: `r.${phone}@example.com` },
        shipping_address: {
          line1: '8 Brigade Road',
          city: 'Bengaluru',
          state: 'Karnataka',
          state_code: '29',
          pincode: '560001',
        },
      },
    },
  );

  if (placed.status >= 400 || !placed.body?.order) {
    throw new Error(`could not seed a delivered order: checkout → ${placed.status} ${JSON.stringify(placed.body).slice(0, 200)}`);
  }
  const orderId = placed.body.order.id;
  for (const status of ['confirmed', 'packed']) {
    await adminOrThrow(`/orders/${orderId}/status`, { method: 'POST', body: { status } });
  }
  await adminOrThrow(`/orders/${orderId}/ship`, { method: 'POST', body: { shipping_mode: 'surface' } });
  await adminOrThrow(`/orders/${orderId}/status`, { method: 'POST', body: { status: 'delivered' } });

  return { orderNumber: placed.body.order.order_number, phone, slug, orderId };
}

interface Summary {
  rating_count: number;
  review_count: number;
  rating_average: number | null;
  recommend_percent: number | null;
  breakdown: Record<string, number>;
}

async function productRow(slug: string) {
  return queryOne<RowDataPacket & { id: number; rating_average: string; rating_count: number; review_count: number }>(
    'SELECT id, rating_average, rating_count, review_count FROM products WHERE slug = ?',
    [slug],
  );
}

/**
 * Removes the rows a previous run of this suite left behind.
 *
 * The suite approves a review and leaves it approved — which is correct
 * behaviour and exactly what broke the second run: the product then starts with
 * a rating and every "moved to 1" assertion counts one too many. Scoped to the
 * author names this file writes, so it can never touch a real customer's words.
 */
const TEST_AUTHORS = ['Review Tester', 'Concerned Buyer', 'Ordinary Reviewer', 'Not A Customer', 'Flooder'];

async function clearPreviousRuns(): Promise<void> {
  const placeholders = TEST_AUTHORS.map(() => '?').join(', ');
  await execute(
    `DELETE rp FROM review_replies rp
       JOIN reviews r ON r.id = rp.review_id
      WHERE r.author_name IN (${placeholders})`,
    TEST_AUTHORS,
  );
  await execute(`DELETE FROM reviews WHERE author_name IN (${placeholders})`, TEST_AUTHORS);
  // Put the catalogue figures back to what the remaining rows justify.
  await execute(
    `UPDATE products p
        SET p.rating_average = COALESCE((
              SELECT ROUND(AVG(r.rating), 2) FROM reviews r
               WHERE r.product_id = p.id AND r.status = 'approved' AND r.deleted_at IS NULL), 0),
            p.rating_count = (
              SELECT COUNT(*) FROM reviews r
               WHERE r.product_id = p.id AND r.status = 'approved' AND r.deleted_at IS NULL),
            p.review_count = (
              SELECT COUNT(*) FROM reviews r
               WHERE r.product_id = p.id AND r.status = 'approved' AND r.deleted_at IS NULL
                 AND r.body IS NOT NULL AND TRIM(r.body) <> '')
      WHERE p.deleted_at IS NULL`,
  );
  await execute(
    "DELETE FROM rate_limits WHERE bucket_key LIKE 'shop.review%' OR bucket_key LIKE 'shop.checkout%' OR bucket_key LIKE 'shop.cart%'",
  );
}

async function main(): Promise<void> {
  process.stdout.write('\nReviews smoke test\n==================\n\n');

  await clearPreviousRuns();

  process.stdout.write('Auth\n');
  const login = await admin<{ access_token: string }>('/auth/login', {
    method: 'POST',
    body: { email: env.superAdmin.email, password: env.superAdmin.password },
  });
  ok('superadmin logs in', login.status === 200 && Boolean(login.body.access_token), login.body);
  token = login.body.access_token;

  const anonymous = await fetch(`${ADMIN}/reviews`);
  ok('the moderation queue is not public', anonymous.status === 401, anonymous.status);

  // ── the gate ───────────────────────────────────────────────────────────────
  process.stdout.write('\nOnly a real delivered purchase earns a review\n');

  const listed = await shop<{ products: { slug: string }[] }>('/products?limit=1&sort=featured');
  const slug = listed.body.products[0].slug;

  const nonsense = await shop<{ eligible: boolean; reason: string }>(
    `/products/${slug}/reviews/eligibility?order_number=VEY9999999&phone=9876543210`,
  );
  ok('an unknown order is refused', nonsense.body.eligible === false, nonsense.body);
  ok('and the refusal says why', nonsense.body.reason === 'no_matching_order', nonsense.body.reason);

  const forged = await shop<{ error: { message: string } }>(`/products/${slug}/reviews`, {
    method: 'POST',
    body: {
      order_number: 'VEY9999999',
      phone: '9876543210',
      rating: 5,
      author_name: 'Not A Customer',
      body: 'Wonderful product, ten out of ten.',
    },
  });
  ok('submitting without a matching order is refused', forged.status === 400, forged.status);

  // An order that exists but has not arrived yet.
  const pendingOrder = await (async () => {
    const products = await shop<{ products: { slug: string }[] }>('/products?limit=1&sort=featured');
    const detail = await shop<{ product: { variants: { id: number }[] } }>(`/products/${products.body.products[0].slug}`);
    const phone = `9${String(Date.now() + 1).slice(-9)}`;
    const cart = await shop<{ cart: { token: string } }>('/cart', { method: 'POST' });
    await shop(`/cart/${cart.body.cart.token}/items`, {
      method: 'POST',
      body: { variant_id: detail.body.product.variants[0].id, quantity: 1 },
    });
    const placed = await shop<{ order: { order_number: string } }>(`/cart/${cart.body.cart.token}/checkout`, {
      method: 'POST',
      body: {
        payment_method: 'cod',
        contact: { first_name: 'Waiting', last_name: 'Customer', phone, email: `w.${phone}@example.com` },
        shipping_address: { line1: '2 Church Street', city: 'Bengaluru', state: 'Karnataka', pincode: '560001' },
      },
    });
    return { orderNumber: placed.body.order.order_number, phone };
  })();

  const undelivered = await shop<{ eligible: boolean; reason: string }>(
    `/products/${slug}/reviews/eligibility?order_number=${pendingOrder.orderNumber}&phone=${pendingOrder.phone}`,
  );
  ok('an undelivered order cannot be reviewed yet', undelivered.body.eligible === false, undelivered.body);
  ok('and it is distinguished from an unknown one', undelivered.body.reason === 'not_delivered', undelivered.body.reason);

  // ── the happy path ─────────────────────────────────────────────────────────
  process.stdout.write('\nA delivered purchase can be reviewed\n');

  const order = await deliveredOrder();
  const eligible = await shop<{ eligible: boolean; suggested_name: string | null }>(
    `/products/${order.slug}/reviews/eligibility?order_number=${order.orderNumber}&phone=${order.phone}`,
  );
  ok('a delivered order is eligible', eligible.body.eligible === true, eligible.body);
  ok('the form is pre-filled from the order', eligible.body.suggested_name === 'Review', eligible.body);

  // Relative to what is already approved, not to zero. The storefront and admin
  // UI suites write real reviews against the same product, and a suite that
  // insists on starting from an empty catalogue only passes when it runs alone.
  const before = await productRow(order.slug);
  const baseCount = Number(before?.rating_count ?? 0);
  const baseReviews = Number(before?.review_count ?? 0);
  const publicBaseline = await shop<{ reviews: unknown[]; summary: Summary }>(`/products/${order.slug}/reviews`);
  const basePublic = publicBaseline.body.summary.rating_count;
  ok('the stored aggregate agrees with the public summary', baseCount === basePublic, {
    stored: baseCount,
    public: basePublic,
  });

  const submitted = await shop<{ review: { id: number; status: string }; message: string }>(
    `/products/${order.slug}/reviews`,
    {
      method: 'POST',
      body: {
        order_number: order.orderNumber,
        phone: order.phone,
        rating: 5,
        title: 'Calmer skin in three weeks',
        body: 'Used it morning and night. Texture is light and it layers well under sunscreen.',
        author_name: 'Review Tester',
        author_location: 'Bengaluru',
        usage_duration: 'one_to_four_weeks',
        would_recommend: true,
      },
    },
  );
  ok('the review is accepted', submitted.status === 201, submitted.body);
  ok('and held for moderation, not published', submitted.body.review.status === 'pending', submitted.body.review);
  ok('the shopper is told it is not live yet', /checked|team/i.test(submitted.body.message), submitted.body.message);

  const reviewId = submitted.body.review.id;

  const publicBefore = await shop<{ reviews: unknown[]; summary: Summary }>(`/products/${order.slug}/reviews`);
  ok(
    'a pending review is invisible to shoppers',
    !publicBefore.body.reviews.some((review) => (review as { title?: string }).title === 'Calmer skin in three weeks'),
    publicBefore.body.reviews.length,
  );
  ok(
    'and contributes nothing to the summary',
    publicBefore.body.summary.rating_count === basePublic,
    publicBefore.body.summary,
  );
  ok(
    'a product with no approved reviews shows no score at all',
    basePublic > 0 || publicBefore.body.summary.rating_average === null,
    publicBefore.body.summary.rating_average,
  );

  const duplicate = await shop<unknown>(`/products/${order.slug}/reviews`, {
    method: 'POST',
    body: {
      order_number: order.orderNumber,
      phone: order.phone,
      rating: 1,
      author_name: 'Review Tester',
      body: 'Changed my mind entirely.',
    },
  });
  ok('a second review from the same purchase is refused', duplicate.status === 409, duplicate.status);

  // ── moderation ─────────────────────────────────────────────────────────────
  process.stdout.write('\nModeration decides what is public\n');

  const queue = await adminOrThrow<{ reviews: { id: number; status: string; next_statuses: string[] }[]; counts: Record<string, number> }>(
    '/reviews?status=pending',
  );
  ok('the review is in the pending queue', queue.reviews.some((r) => r.id === reviewId), queue.counts);
  const queued = queue.reviews.find((r) => r.id === reviewId)!;
  ok('the queue offers only legal moves', !queued.next_statuses.includes('hidden'), queued.next_statuses);

  const badTransition = await admin<unknown>(`/reviews/${reviewId}/status`, {
    method: 'POST',
    body: { status: 'hidden' },
  });
  ok('an illegal transition is refused', badTransition.status === 409, badTransition.status);

  const noReason = await admin<unknown>(`/reviews/${reviewId}/status`, {
    method: 'POST',
    body: { status: 'rejected' },
  });
  ok('rejecting without a reason is refused', noReason.status === 400, noReason.status);

  const earlyReply = await admin<unknown>(`/reviews/${reviewId}/reply`, {
    method: 'POST',
    body: { body: 'Thanks so much for this!' },
  });
  ok('replying before approval is refused', earlyReply.status === 400, earlyReply.status);

  const approved = await adminOrThrow<{ review: { status: string } }>(`/reviews/${reviewId}/status`, {
    method: 'POST',
    body: { status: 'approved', note: 'Reads genuine, verified purchase.' },
  });
  ok('approving works', approved.review.status === 'approved', approved.review);

  // ── the arithmetic ─────────────────────────────────────────────────────────
  process.stdout.write('\nThe catalogue figures follow moderation\n');

  const after = await productRow(order.slug);
  ok('rating_count moved by one', Number(after?.rating_count) === baseCount + 1, { baseCount, after });
  ok('review_count counts the written one', Number(after?.review_count) === baseReviews + 1, { baseReviews, after });

  const publicAfter = await shop<{ reviews: { rating: number; is_verified_purchase: boolean }[]; summary: Summary }>(
    `/products/${order.slug}/reviews`,
  );
  ok(
    'the review is now public',
    publicAfter.body.summary.rating_count === basePublic + 1,
    publicAfter.body.summary,
  );
  ok('and marked a verified purchase', publicAfter.body.reviews[0].is_verified_purchase === true);
  ok('the summary matches the stored aggregate', publicAfter.body.summary.rating_average === Number(after?.rating_average), {
    summary: publicAfter.body.summary.rating_average,
    stored: after?.rating_average,
  });
  ok('the star breakdown adds up to the count', Object.values(publicAfter.body.summary.breakdown).reduce((a, b) => a + b, 0) === publicAfter.body.summary.rating_count, publicAfter.body.summary);
  ok('recommend percentage is reported', publicAfter.body.summary.recommend_percent !== null, publicAfter.body.summary);

  const reply = await adminOrThrow<{ review: { reply: { body: string } | null } }>(`/reviews/${reviewId}/reply`, {
    method: 'POST',
    body: { body: 'Thank you — glad the texture worked for you.' },
  });
  ok('an approved review can be replied to', reply.review.reply !== null, reply.review.reply);

  const withReply = await shop<{ reviews: { reply: { body: string } | null }[] }>(`/products/${order.slug}/reviews`);
  ok('the reply shows on the storefront', withReply.body.reviews[0].reply !== null, withReply.body.reviews[0].reply);

  // ── hiding takes it back out ───────────────────────────────────────────────
  process.stdout.write('\nHiding reverses all of it\n');

  await adminOrThrow(`/reviews/${reviewId}/status`, { method: 'POST', body: { status: 'hidden' } });
  const hidden = await productRow(order.slug);
  ok('hiding takes it back out of the rating', Number(hidden?.rating_count) === baseCount, { baseCount, hidden });
  const publicHidden = await shop<{ reviews: { title: string | null }[]; summary: Summary }>(
    `/products/${order.slug}/reviews`,
  );
  ok(
    'and removes it from the storefront',
    !publicHidden.body.reviews.some((review) => review.title === 'Calmer skin in three weeks'),
    publicHidden.body.summary,
  );

  await adminOrThrow(`/reviews/${reviewId}/status`, { method: 'POST', body: { status: 'approved' } });
  const restored = await productRow(order.slug);
  ok('re-approving restores it', Number(restored?.rating_count) === baseCount + 1, { baseCount, restored });

  // ── adverse reactions ──────────────────────────────────────────────────────
  process.stdout.write('\nA reported skin reaction is treated as a safety signal\n');

  const second = await deliveredOrder();
  const adverse = await shop<{ review: { id: number }; message: string }>(`/products/${second.slug}/reviews`, {
    method: 'POST',
    body: {
      order_number: second.orderNumber,
      phone: second.phone,
      rating: 1,
      title: 'Burning and a rash',
      body: 'My face was burning within minutes and I developed a rash. Had to see a dermatologist.',
      author_name: 'Concerned Buyer',
    },
  });
  ok('it is accepted, not swallowed', adverse.status === 201, { status: adverse.status, body: adverse.body });
  if (adverse.status !== 201) throw new Error('adverse-reaction review was not accepted; the checks below cannot run');
  ok('the shopper is told it will be looked at', /reaction/i.test(adverse.body.message ?? ''), adverse.body.message);

  const flaggedQueue = await adminOrThrow<{ reviews: { id: number; flagged_adverse_reaction: boolean }[] }>(
    '/reviews?status=pending',
  );
  const flaggedRow = flaggedQueue.reviews.find((r) => r.id === adverse.body.review.id);
  ok('it is flagged as an adverse reaction', flaggedRow?.flagged_adverse_reaction === true, flaggedRow);
  ok('and sorted to the top of the queue', flaggedQueue.reviews[0]?.id === adverse.body.review.id, {
    first: flaggedQueue.reviews[0]?.id,
    expected: adverse.body.review.id,
  });

  const onlyFlagged = await adminOrThrow<{ reviews: { flagged_adverse_reaction: boolean }[] }>(
    '/reviews?flagged=true',
  );
  ok('the flagged filter returns only flagged rows', onlyFlagged.reviews.every((r) => r.flagged_adverse_reaction), onlyFlagged.reviews.length);

  // A neutral review must not trip the detector.
  const third = await deliveredOrder();
  const neutral = await shop<{ review: { id: number } }>(`/products/${third.slug}/reviews`, {
    method: 'POST',
    body: {
      order_number: third.orderNumber,
      phone: third.phone,
      rating: 4,
      title: 'Pleasant daily cleanser',
      body: 'Lathers well and rinses clean. The scent is light.',
      author_name: 'Ordinary Reviewer',
    },
  });
  const neutralRow = await adminOrThrow<{ review: { flagged_adverse_reaction: boolean } }>(
    `/reviews/${neutral.body.review.id}`,
  );
  ok('an ordinary review is not flagged', neutralRow.review.flagged_adverse_reaction === false, neutralRow.review);

  // ── the limiter ────────────────────────────────────────────────────────────
  process.stdout.write('\nSubmission is rate limited\n');

  const flood = await shop<unknown>(`/products/${slug}/reviews`, {
    method: 'POST',
    body: { order_number: 'VEY0000000', phone: '9876543210', rating: 5, author_name: 'Flooder' },
  });
  ok('a burst of submissions is throttled', flood.status === 429, flood.status);

  // Cleared so the checks below exercise validation, not the bucket they just
  // filled. The limiter is keyed per IP and this suite is one IP.
  await execute("DELETE FROM rate_limits WHERE bucket_key LIKE 'shop.review%'");

  // ── validation ─────────────────────────────────────────────────────────────
  process.stdout.write('\nValidation\n');

  const badRating = await shop<unknown>(`/products/${slug}/reviews`, {
    method: 'POST',
    body: { order_number: 'VEY1', phone: '9876543210', rating: 9, author_name: 'X' },
  });
  ok('a rating outside 1–5 is rejected', badRating.status === 422, badRating.status);

  const badPhone = await shop<unknown>(`/products/${slug}/reviews`, {
    method: 'POST',
    body: { order_number: 'VEY1', phone: '12345', rating: 5, author_name: 'Someone' },
  });
  ok('a malformed phone number is rejected', badPhone.status === 422, badPhone.status);

  const unknownProduct = await shop<unknown>('/products/not-a-real-product/reviews');
  ok('reviews for an unknown product → 404', unknownProduct.status === 404, unknownProduct.status);

  process.stdout.write(`\n${'─'.repeat(60)}\n${passed} passed, ${failed} failed\n`);
  if (failures.length > 0) {
    process.stdout.write('\nFailures:\n');
    for (const failure of failures) process.stdout.write(`  • ${failure}\n`);
  }
  process.stdout.write('\n');
}

main()
  .catch((error) => {
    process.stdout.write(`\nFATAL: ${error instanceof Error ? error.message : String(error)}\n\n`);
    failed += 1;
  })
  .finally(async () => {
    await closePool();
    process.exit(failed > 0 ? 1 : 0);
  });
