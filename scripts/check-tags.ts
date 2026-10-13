/**
 * The shelf-tag rule, exercised directly.
 *
 *   npx tsx scripts/check-tags.ts
 *
 * No database and no HTTP: the rule is a pure function of a row, and the cases
 * that matter most are the ones the catalogue does not happen to contain today —
 * a launch that has aged past the window, a campaign whose end date went by last
 * night, a merchandiser typing "New" into the wording box to get around the
 * calendar. Seeding cannot produce those on demand, so they are constructed.
 */
import { NEW_WINDOW_DAYS, productTag } from '../src/modules/storefront/storefront.service';
import type { StorefrontProductRow } from '../src/modules/storefront/storefront.repository';

let passed = 0;
const failures: string[] = [];

function ok(label: string, condition: boolean, detail?: unknown): void {
  if (condition) {
    passed += 1;
    process.stdout.write(`  ✓ ${label}\n`);
  } else {
    failures.push(label);
    process.stdout.write(`  ✗ ${label}${detail === undefined ? '' : ` — ${JSON.stringify(detail)}`}\n`);
  }
}

const daysAgo = (days: number) => new Date(Date.now() - days * 86_400_000);
const inDays = (days: number) => new Date(Date.now() + days * 86_400_000);

/**
 * The four fields the rule actually reads.
 *
 * Typed on its own rather than as `Partial<StorefrontProductRow>`: that type
 * extends mysql2's RowDataPacket, whose `constructor` is narrowed to a literal,
 * so a plain object literal is not assignable to it however few keys it has.
 */
type TagFields = {
  is_new?: number;
  is_bestseller?: number;
  badge?: string | null;
  badge_expires_at?: Date | null;
  published_at?: Date | null;
};

/** A row with nothing claimed, which the cases below vary one field at a time. */
function row(overrides: TagFields): StorefrontProductRow {
  return {
    is_new: 0,
    is_bestseller: 0,
    badge: null,
    badge_expires_at: null,
    published_at: daysAgo(5),
    ...overrides,
  } as StorefrontProductRow;
}

process.stdout.write('\nShelf tags\n\nNothing by default\n');
ok('a plain product wears no tag', productTag(row({})) === null);
ok('an unpublished product wears no tag', productTag(row({ published_at: null })) === null);
ok('a recent product is not new merely for being recent', productTag(row({ published_at: daysAgo(1) })) === null);

process.stdout.write('\nNew, and the calendar\n');
ok('a launch inside the window is new', productTag(row({ is_new: 1 }))?.key === 'new');
ok(
  'the day before the window closes it is still new',
  productTag(row({ is_new: 1, published_at: daysAgo(NEW_WINDOW_DAYS - 1) }))?.key === 'new',
);
ok(
  'a day past the window it is not, with the flag still on',
  productTag(row({ is_new: 1, published_at: daysAgo(NEW_WINDOW_DAYS + 1) })) === null,
);
ok('a launch with no publication date is not new', productTag(row({ is_new: 1, published_at: null })) === null);

process.stdout.write('\nBest seller\n');
ok('the flag is enough', productTag(row({ is_bestseller: 1 }))?.label === 'Best seller');
ok('it does not expire on its own', productTag(row({ is_bestseller: 1, published_at: daysAgo(900) }))?.key === 'bestseller');
ok(
  'it outranks a launch',
  productTag(row({ is_bestseller: 1, is_new: 1 }))?.key === 'bestseller',
);

process.stdout.write('\nA badge written by hand\n');
ok('bespoke wording is shown as written', productTag(row({ badge: 'Limited edition' }))?.label === 'Limited edition');
ok('it outranks bestseller, being the more specific claim', productTag(row({ badge: 'Award winner', is_bestseller: 1 }))?.label === 'Award winner');
ok('an end date in the future keeps it', productTag(row({ badge: 'Diwali edit', badge_expires_at: inDays(3) }))?.label === 'Diwali edit');
ok('an end date in the past removes it', productTag(row({ badge: 'Diwali edit', badge_expires_at: daysAgo(1) })) === null);
ok(
  'an expired badge falls through to whatever else was earned',
  productTag(row({ badge: 'Diwali edit', badge_expires_at: daysAgo(1), is_bestseller: 1 }))?.key === 'bestseller',
);
ok('blank wording is not a tag', productTag(row({ badge: '   ' })) === null);

process.stdout.write('\nThe wording box is not a way round the rules\n');
// The reason this matters: the whole point of deriving "New" from the date is
// that the claim cannot go stale. A free-text badge reading "New" with no expiry
// would put that back, and nobody would notice for months.
ok(
  'typing "New" is read as the claim, not as bespoke wording',
  productTag(row({ badge: 'New', published_at: daysAgo(5) }))?.key === 'new',
);
ok(
  'and it lapses on the same calendar',
  productTag(row({ badge: 'New', published_at: daysAgo(NEW_WINDOW_DAYS + 1) })) === null,
);
ok(
  'typing "Best seller" is read as the claim',
  productTag(row({ badge: 'Best seller' }))?.key === 'bestseller',
);
ok('however it is spelled', productTag(row({ badge: 'bestseller' }))?.key === 'bestseller');

process.stdout.write('\nShape\n');
const shapes = [row({ is_new: 1 }), row({ is_bestseller: 1 }), row({ badge: 'Limited edition' })].map(productTag);
ok(
  'every tag carries a key, a label and a tone',
  shapes.every((tag) => tag !== null && typeof tag.label === 'string' && Boolean(tag.key) && Boolean(tag.tone)),
);
ok('a launch is drawn as the light one, everything durable as the dark one', shapes[0]?.tone === 'accent' && shapes[1]?.tone === 'dark' && shapes[2]?.tone === 'dark');

process.stdout.write(`\n${passed} passed, ${failures.length} failed\n`);
if (failures.length) {
  failures.forEach((failure) => process.stdout.write(`  · ${failure}\n`));
  process.exit(1);
}
// Importing the service pulls in the database pool, whose timers would otherwise
// keep this process alive after it has nothing left to say.
process.exit(0);
