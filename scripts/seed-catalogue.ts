/**
 * Seeds a realistic Veylor catalogue.
 *
 *   npm run seed:catalogue
 *
 * The dev database accumulates smoke-test junk — "UI Smoke Serum" ×11, a dozen
 * throwaway categories — which is fine for assertions and useless for looking at
 * the storefront. This archives that noise and writes the nine formulas the
 * brand actually sells, with variants, stock, imagery, SEO and three curated
 * collections.
 *
 * It is idempotent: run it twice and you get the same catalogue, not eighteen
 * products. Every product is matched on its slug.
 *
 * Product imagery is generated here rather than shipped as binaries — flat
 * editorial compositions in the brand palette, so the grid reads as a real
 * shelf without pretending to be photography.
 */
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import sharp from 'sharp';
import { env } from '../src/config/env';
import { closePool, execute, queryOne, verifyConnection, type RowDataPacket } from '../src/db/pool';
import { withTransaction } from '../src/db/transaction';
import { shopDirectory } from '../src/platform/shops/shopDirectory';
import { tenancy, type ShopContext } from '../src/platform/tenancy/context';

// ── brand palette ────────────────────────────────────────────────────────────
const PALETTE = {
  cream: '#FAFAF6',
  ivory: '#F5EFE6',
  champagne: '#EDE0CF',
  stone: '#C4AE97',
  warm: '#8C6D54',
  espresso: '#1A1208',
  botanical: '#6B8F71',
  sage: '#A8BBA4',
  sageBg: '#D4DECC',
  gold: '#B8892A',
  blush: '#E9D5C4',
  peach: '#E8C8A0',
};

interface VariantSeed {
  sku: string;
  title: string | null;
  netQuantity: string;
  volumeMl: number;
  mrp: number;
  price: number;
  stock: number;
  isDefault?: boolean;
}

interface ProductSeed {
  slug: string;
  name: string;
  subtitle: string;
  category: string;
  shortDescription: string;
  description: string;
  inci: string;
  texture: string;
  scent: string;
  suitability: string;
  patchTest: string;
  routine: 'cleanse' | 'treat' | 'hydrate' | 'protect';
  timeOfDay: 'AM' | 'PM' | 'BOTH';
  shelfLifeMonths: number;
  paoMonths: number;
  isNew?: boolean;
  isBestseller?: boolean;
  badge?: string;
  rating: number;
  reviewCount: number;
  totalSold: number;
  /** Bottle colour, ground colour — the two decisions the artwork makes. */
  art: { bottle: string; ground: string; cap: string };
  variants: VariantSeed[];
  metaTitle: string;
  metaDescription: string;
}

const CATEGORIES: { slug: string; name: string; description: string }[] = [
  { slug: 'cleanse', name: 'Cleanse', description: 'Two ways to take the day off without stripping the barrier.' },
  { slug: 'treat', name: 'Treat', description: 'The actives, at the percentages the research actually used.' },
  { slug: 'hydrate', name: 'Hydrate', description: 'Moisture that holds through Indian heat and air conditioning.' },
  { slug: 'protect', name: 'Protect', description: 'The step that decides whether the other eight were worth it.' },
];

const PRODUCTS: ProductSeed[] = [
  {
    slug: 'clarify-gentle-gel-cleanser',
    name: 'Clarify Gentle Gel Cleanser',
    subtitle: 'Amino-acid gel · pH 5.5',
    category: 'cleanse',
    shortDescription: 'A low-foam gel that removes sunscreen and city grime without the tight, squeaky finish.',
    description:
      'Most cleansers marketed as "deep cleansing" work by stripping — you feel clean because your barrier is not there any more. This one uses amino-acid surfactants at pH 5.5, close to skin\'s own, so it lifts sunscreen, sebum and particulate pollution and leaves the lipids that keep water in.\n\nIt is the cleanser we use before every other step in the range, morning and night.',
    inci: 'Aqua, Sodium Cocoyl Glycinate, Glycerin, Coco-Betaine, Sodium Lauroyl Sarcosinate, Panthenol, Allantoin, Sodium PCA, Citric Acid, Sodium Benzoate, Potassium Sorbate.',
    texture: 'Clear gel, low foam',
    scent: 'Unscented',
    suitability: 'All skin types, including sensitive and post-procedure skin.',
    patchTest: 'Patch test behind the ear for 24 hours before first use.',
    routine: 'cleanse',
    timeOfDay: 'BOTH',
    shelfLifeMonths: 36,
    paoMonths: 12,
    rating: 4.7,
    reviewCount: 412,
    totalSold: 3180,
    art: { bottle: PALETTE.ivory, ground: PALETTE.sageBg, cap: PALETTE.botanical },
    variants: [
      { sku: 'VEY-CLR-100', title: '100 ml', netQuantity: '100 ml', volumeMl: 100, mrp: 645, price: 545, stock: 140, isDefault: true },
      { sku: 'VEY-CLR-200', title: '200 ml', netQuantity: '200 ml', volumeMl: 200, mrp: 995, price: 845, stock: 60 },
    ],
    metaTitle: 'Clarify Gentle Gel Cleanser · pH 5.5 Amino-Acid Cleanser | Veylor',
    metaDescription:
      'A pH 5.5 amino-acid gel cleanser that removes sunscreen and pollution without stripping. Fragrance free, dermatologist tested, made in India.',
  },
  {
    slug: 'milk-cleanser-no-3',
    name: 'Milk Cleanser No. 3',
    subtitle: 'First cleanse · dissolves SPF',
    category: 'cleanse',
    shortDescription: 'A pouring milk that melts sunscreen and long-wear makeup, then rinses clean with water.',
    description:
      'The first half of a double cleanse, in a texture that does not feel like an oil slick. Sunflower and rice bran esters dissolve mineral and chemical sunscreen; the emulsifier is generous enough that it rinses without a film, so you can follow with the gel cleanser or stop here.\n\nNo. 3 because the first two versions left a residue we could not live with.',
    inci: 'Aqua, Helianthus Annuus Seed Oil, Glycerin, Cetearyl Alcohol, Oryza Sativa Bran Oil, Cetearyl Glucoside, Squalane, Panthenol, Tocopherol, Xanthan Gum, Sodium Benzoate, Potassium Sorbate, Citric Acid.',
    texture: 'Pourable milk',
    scent: 'Naturally faint, from the oils',
    suitability: 'Dry, normal and combination skin. Useful for anyone wearing SPF 50 daily.',
    patchTest: 'Patch test behind the ear for 24 hours before first use.',
    routine: 'cleanse',
    timeOfDay: 'PM',
    shelfLifeMonths: 30,
    paoMonths: 9,
    rating: 4.6,
    reviewCount: 188,
    totalSold: 1420,
    art: { bottle: PALETTE.cream, ground: PALETTE.blush, cap: PALETTE.warm },
    variants: [
      { sku: 'VEY-MLK-150', title: '150 ml', netQuantity: '150 ml', volumeMl: 150, mrp: 695, price: 595, stock: 95, isDefault: true },
    ],
    metaTitle: 'Milk Cleanser No. 3 · First-Cleanse Milk for SPF | Veylor',
    metaDescription:
      'A rinse-off cleansing milk that dissolves SPF 50 and long-wear makeup without a residue. Fragrance free and made in India.',
  },
  {
    slug: 'radiance-10-niacinamide-serum',
    name: 'Radiance 10% Niacinamide Serum',
    subtitle: '10% niacinamide + 1% zinc PCA',
    category: 'treat',
    shortDescription: 'Ten per cent niacinamide for visible pores, uneven tone and oil that shows up by noon.',
    description:
      'Niacinamide is one of the few actives with a genuinely broad evidence base — barrier lipids, sebum, pigment transfer, redness. Ten per cent is where the pore and sebum studies sit, and where most people stop tolerating more, so that is where we stopped.\n\nZinc PCA at 1% does the oil-control work that gets wrongly credited to niacinamide alone. Expect a difference in shine within two weeks and in tone by week eight.',
    inci: 'Aqua, Niacinamide, Propanediol, Zinc PCA, Glycerin, Pentylene Glycol, Sodium Hyaluronate, Panthenol, Allantoin, Xanthan Gum, Ethylhexylglycerin, Phenoxyethanol, Citric Acid.',
    texture: 'Water-light, absorbs in seconds',
    scent: 'Unscented',
    suitability: 'Oily and combination skin. Start alternate nights if you are new to niacinamide.',
    patchTest: 'Patch test behind the ear for 24 hours. Introduce one new active at a time.',
    routine: 'treat',
    timeOfDay: 'BOTH',
    shelfLifeMonths: 24,
    paoMonths: 6,
    isBestseller: true,
    badge: 'Bestseller',
    rating: 4.8,
    reviewCount: 1264,
    totalSold: 8940,
    art: { bottle: PALETTE.champagne, ground: PALETTE.ivory, cap: PALETTE.espresso },
    variants: [
      { sku: 'VEY-NIA-30', title: '30 ml', netQuantity: '30 ml', volumeMl: 30, mrp: 1099, price: 899, stock: 220, isDefault: true },
      { sku: 'VEY-NIA-50', title: '50 ml', netQuantity: '50 ml', volumeMl: 50, mrp: 1699, price: 1349, stock: 85 },
    ],
    metaTitle: '10% Niacinamide + Zinc Serum for Pores & Oil | Veylor',
    metaDescription:
      'A 10% niacinamide serum with 1% zinc PCA for enlarged pores, uneven tone and midday shine. Dermatologist tested, made in India.',
  },
  {
    slug: 'renew-retinal-night-serum',
    name: 'Renew 0.3% Retinal Night Serum',
    subtitle: 'Encapsulated retinaldehyde',
    category: 'treat',
    shortDescription: 'Retinal — one step from retinoic acid — encapsulated so the strength arrives without the peeling.',
    description:
      'Retinaldehyde converts to retinoic acid in a single step, which is why it works faster than retinol at a fraction of the concentration. The trade-off is usually irritation; encapsulation slows the release so the dose arrives over hours rather than minutes.\n\nStart twice a week. Most people are at nightly use by week six. If you are peeling, you are going too fast — that is not the product working.',
    inci: 'Aqua, Caprylic/Capric Triglyceride, Glycerin, Retinal (encapsulated), Squalane, Bisabolol, Tocopherol, Panthenol, Ceramide NP, Hydroxyethyl Acrylate/Sodium Acryloyldimethyl Taurate Copolymer, Phenoxyethanol, Ethylhexylglycerin.',
    texture: 'Light lotion, faintly yellow',
    scent: 'Unscented',
    suitability: 'Not for use during pregnancy or breastfeeding. Sunscreen is not optional alongside this.',
    patchTest: 'Patch test for 24 hours. Introduce twice weekly and build up.',
    routine: 'treat',
    timeOfDay: 'PM',
    shelfLifeMonths: 24,
    paoMonths: 6,
    isBestseller: true,
    badge: 'Bestseller',
    rating: 4.9,
    reviewCount: 736,
    totalSold: 5210,
    art: { bottle: PALETTE.warm, ground: PALETTE.champagne, cap: PALETTE.gold },
    variants: [
      { sku: 'VEY-RTN-30', title: '30 ml', netQuantity: '30 ml', volumeMl: 30, mrp: 1799, price: 1499, stock: 74, isDefault: true },
    ],
    metaTitle: '0.3% Encapsulated Retinal Night Serum | Veylor',
    metaDescription:
      'Encapsulated 0.3% retinaldehyde for fine lines and texture, buffered with ceramides and bisabolol to reduce irritation. Made in India.',
  },
  {
    slug: 'bright-12-vitamin-c-serum',
    name: 'Bright 12% Vitamin C Serum',
    subtitle: '12% THD ascorbate · stable',
    category: 'treat',
    shortDescription: 'An oil-soluble vitamin C that does not oxidise into an orange mess by week three.',
    description:
      'L-ascorbic acid is the most studied form of vitamin C and the least stable — in Indian humidity, an opened bottle is often past its best inside a month. Tetrahexyldecyl ascorbate is oil-soluble, stable at skin pH, and penetrates without the sting.\n\nTwelve per cent, with ferulic acid and vitamin E to extend the antioxidant network. Use it in the morning, under sunscreen.',
    inci: 'Caprylic/Capric Triglyceride, Tetrahexyldecyl Ascorbate, Squalane, Isopropyl Palmitate, Tocopherol, Ferulic Acid, Bisabolol, Ubiquinone.',
    texture: 'Dry oil, sinks without shine',
    scent: 'Unscented',
    suitability: 'All skin types. Layer under moisturiser and sunscreen in the morning.',
    patchTest: 'Patch test behind the ear for 24 hours before first use.',
    routine: 'treat',
    timeOfDay: 'AM',
    shelfLifeMonths: 24,
    paoMonths: 6,
    isNew: true,
    badge: 'New',
    rating: 4.7,
    reviewCount: 214,
    totalSold: 1640,
    art: { bottle: PALETTE.peach, ground: PALETTE.cream, cap: PALETTE.espresso },
    variants: [
      { sku: 'VEY-VTC-30', title: '30 ml', netQuantity: '30 ml', volumeMl: 30, mrp: 1399, price: 1149, stock: 130, isDefault: true },
    ],
    metaTitle: '12% Vitamin C Serum (THD Ascorbate) | Veylor',
    metaDescription:
      'A stable 12% tetrahexyldecyl ascorbate serum with ferulic acid and vitamin E. No sting, no oxidation. Dermatologist tested, made in India.',
  },
  {
    slug: 'quench-hyaluronic-b5-serum',
    name: 'Quench Hyaluronic + B5 Serum',
    subtitle: 'Five molecular weights',
    category: 'treat',
    shortDescription: 'Hydration that holds in air conditioning, without the tacky film.',
    description:
      'A single molecular weight of hyaluronic acid sits on the surface and, in dry air, can pull water out of your skin rather than into it. Five weights, from 8 kDa to 1.5 MDa, distribute through the upper layers instead — and 2% panthenol gives the water something to hold on to.\n\nApply to damp skin and seal it with a moisturiser. That second step is the one people skip and then blame the serum.',
    inci: 'Aqua, Glycerin, Sodium Hyaluronate (multiple molecular weights), Panthenol, Betaine, Sodium PCA, Trehalose, Allantoin, Pentylene Glycol, Xanthan Gum, Phenoxyethanol, Ethylhexylglycerin.',
    texture: 'Slippery water-gel',
    scent: 'Unscented',
    suitability: 'All skin types, including very sensitive and compromised barriers.',
    patchTest: 'Patch test behind the ear for 24 hours before first use.',
    routine: 'treat',
    timeOfDay: 'BOTH',
    shelfLifeMonths: 30,
    paoMonths: 9,
    rating: 4.6,
    reviewCount: 508,
    totalSold: 4120,
    art: { bottle: PALETTE.sageBg, ground: PALETTE.ivory, cap: PALETTE.botanical },
    variants: [
      { sku: 'VEY-HYA-30', title: '30 ml', netQuantity: '30 ml', volumeMl: 30, mrp: 949, price: 799, stock: 165, isDefault: true },
    ],
    metaTitle: 'Hyaluronic Acid + B5 Hydrating Serum | Veylor',
    metaDescription:
      'Five molecular weights of hyaluronic acid with 2% panthenol for lasting hydration without tackiness. Fragrance free, made in India.',
  },
  {
    slug: 'barrier-ceramide-moisturiser',
    name: 'Barrier Ceramide Moisturiser',
    subtitle: 'Ceramides at a 3:1:1 ratio',
    category: 'hydrate',
    shortDescription: 'A repair cream for skin that has been over-exfoliated, over-treated or simply had enough.',
    description:
      'Barrier lipids sit in a specific ratio — roughly three parts ceramide to one cholesterol to one fatty acid. Get the ratio wrong and you can slow repair rather than speed it, which is why we print ours.\n\nRich enough for a compromised barrier, light enough that it is not a mask. If your skin stings when you apply anything at all, start here and add the actives back in a fortnight.',
    inci: 'Aqua, Glycerin, Caprylic/Capric Triglyceride, Cetearyl Alcohol, Ceramide NP, Ceramide AP, Ceramide EOP, Cholesterol, Phytosphingosine, Squalane, Panthenol, Sodium Hyaluronate, Allantoin, Bisabolol, Xanthan Gum, Phenoxyethanol, Ethylhexylglycerin.',
    texture: 'Cushioned cream, matte finish',
    scent: 'Unscented',
    suitability: 'Dry, sensitive and barrier-compromised skin. Safe alongside retinal.',
    patchTest: 'Patch test behind the ear for 24 hours before first use.',
    routine: 'hydrate',
    timeOfDay: 'BOTH',
    shelfLifeMonths: 30,
    paoMonths: 9,
    rating: 4.8,
    reviewCount: 892,
    totalSold: 6380,
    art: { bottle: PALETTE.ivory, ground: PALETTE.champagne, cap: PALETTE.warm },
    variants: [
      { sku: 'VEY-BAR-50', title: '50 g', netQuantity: '50 g', volumeMl: 50, mrp: 1249, price: 1049, stock: 118, isDefault: true },
      { sku: 'VEY-BAR-15', title: '15 g travel', netQuantity: '15 g', volumeMl: 15, mrp: 449, price: 399, stock: 200 },
    ],
    metaTitle: 'Ceramide Barrier Repair Moisturiser 3:1:1 | Veylor',
    metaDescription:
      'A ceramide, cholesterol and fatty-acid moisturiser at the 3:1:1 barrier ratio, for over-exfoliated and sensitised skin. Made in India.',
  },
  {
    slug: 'featherlight-gel-moisturiser',
    name: 'Featherlight Gel Moisturiser',
    subtitle: 'Oil-free · humidity-proof',
    category: 'hydrate',
    shortDescription: 'The moisturiser for people who say moisturiser makes them break out.',
    description:
      'Oil-free does not have to mean it stops working by lunchtime. Glycerin and betaine do the humectant work; a light film former stops it evaporating off in the heat, without occlusives that sit heavy on oily skin.\n\nWorks under sunscreen and under makeup, in Chennai in May.',
    inci: 'Aqua, Glycerin, Dimethicone, Betaine, Sodium Hyaluronate, Panthenol, Allantoin, Zinc PCA, Pentylene Glycol, Carbomer, Sodium Hydroxide, Phenoxyethanol, Ethylhexylglycerin.',
    texture: 'Fresh gel, no residue',
    scent: 'Unscented',
    suitability: 'Oily, combination and acne-prone skin. Non-comedogenic.',
    patchTest: 'Patch test behind the ear for 24 hours before first use.',
    routine: 'hydrate',
    timeOfDay: 'BOTH',
    shelfLifeMonths: 30,
    paoMonths: 9,
    isNew: true,
    badge: 'New',
    rating: 4.5,
    reviewCount: 146,
    totalSold: 980,
    art: { bottle: PALETTE.sage, ground: PALETTE.cream, cap: PALETTE.espresso },
    variants: [
      { sku: 'VEY-GEL-50', title: '50 g', netQuantity: '50 g', volumeMl: 50, mrp: 999, price: 849, stock: 142, isDefault: true },
    ],
    metaTitle: 'Oil-Free Gel Moisturiser for Oily Skin | Veylor',
    metaDescription:
      'A lightweight oil-free gel moisturiser with glycerin, zinc PCA and hyaluronic acid for oily and acne-prone skin in humid weather.',
  },
  {
    slug: 'daily-shield-spf-50',
    name: 'Daily Shield SPF 50 PA++++',
    subtitle: 'No white cast · no alcohol finish',
    category: 'protect',
    shortDescription: 'A broad-spectrum SPF 50 that disappears on Indian skin tones and does not sting the eyes.',
    description:
      'Most of the sunscreens that vanish on deeper skin tones do it by being almost entirely alcohol, which is why they sting and why they are gone in three hours. This one uses modern filters in an emollient base — a dewy, invisible finish that holds.\n\nPA++++ is the UVA rating, and it is the one that matters for pigmentation. Two fingers for the face and neck; reapply every three hours if you are outdoors.',
    inci: 'Aqua, Diethylamino Hydroxybenzoyl Hexyl Benzoate, Ethylhexyl Triazone, Bis-Ethylhexyloxyphenol Methoxyphenyl Triazine, Glycerin, Caprylic/Capric Triglyceride, Butyl Methoxydibenzoylmethane, Niacinamide, Tocopherol, Panthenol, Xanthan Gum, Phenoxyethanol, Ethylhexylglycerin.',
    texture: 'Milky fluid, dewy finish',
    scent: 'Unscented',
    suitability: 'All skin tones and types. Safe over retinal and acids.',
    patchTest: 'Patch test behind the ear for 24 hours before first use.',
    routine: 'protect',
    timeOfDay: 'AM',
    shelfLifeMonths: 30,
    paoMonths: 12,
    isBestseller: true,
    badge: 'Bestseller',
    rating: 4.9,
    reviewCount: 1583,
    totalSold: 11240,
    art: { bottle: PALETTE.cream, ground: PALETTE.peach, cap: PALETTE.gold },
    variants: [
      { sku: 'VEY-SPF-50', title: '50 ml', netQuantity: '50 ml', volumeMl: 50, mrp: 899, price: 749, stock: 260, isDefault: true },
    ],
    metaTitle: 'Daily Shield SPF 50 PA++++ Sunscreen, No White Cast | Veylor',
    metaDescription:
      'A broad-spectrum SPF 50 PA++++ sunscreen with no white cast and no alcohol sting, made for Indian skin tones and Indian weather.',
  },
];

const COLLECTIONS: { slug: string; title: string; subtitle: string; description: string; products: string[] }[] = [
  {
    slug: 'the-starter-ritual',
    title: 'The Starter Ritual',
    subtitle: 'Three steps, nothing extra',
    description:
      'If you are building a routine from nothing, this is the order to build it in: cleanse, hydrate, protect. Add an active only once these three are a habit.',
    products: ['clarify-gentle-gel-cleanser', 'quench-hyaluronic-b5-serum', 'daily-shield-spf-50'],
  },
  {
    slug: 'pigmentation-and-dark-spots',
    title: 'For Pigmentation & Dark Spots',
    subtitle: 'Tone, evenly, over months',
    description:
      'Pigmentation responds to consistency rather than strength. Vitamin C in the morning, niacinamide through the day, retinal at night — and sunscreen, without which none of the other three hold.',
    products: [
      'bright-12-vitamin-c-serum',
      'radiance-10-niacinamide-serum',
      'renew-retinal-night-serum',
      'daily-shield-spf-50',
    ],
  },
  {
    slug: 'barrier-repair-edit',
    title: 'The Barrier Repair Edit',
    subtitle: 'When your skin has had enough',
    description:
      'Stinging, flaking, reacting to things that never bothered you before — that is a barrier, not a skin type. Strip the routine back to these three for a fortnight.',
    products: ['milk-cleanser-no-3', 'quench-hyaluronic-b5-serum', 'barrier-ceramide-moisturiser'],
  },
];

// ── artwork ──────────────────────────────────────────────────────────────────

/**
 * Two compositions per product: the bottle centred on its ground, and a wider
 * "in situ" crop. Flat vector shapes rather than fake photography — a product
 * grid needs to read as a shelf, and honest illustration does that without
 * claiming to be a photograph of a thing that does not exist.
 */
function bottleSvg(art: ProductSeed['art'], name: string, netQuantity: string, wide: boolean): string {
  const W = 1200;
  const H = wide ? 1200 : 1500;
  const cx = W / 2;
  const bodyW = wide ? 300 : 340;
  const bodyH = wide ? 520 : 640;
  const bodyY = H / 2 - bodyH / 2 + (wide ? 40 : 60);
  const capH = wide ? 90 : 110;
  const label = name.split(' ')[0].toUpperCase();

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">
  <rect width="${W}" height="${H}" fill="${art.ground}"/>
  ${wide ? `<circle cx="${cx}" cy="${H / 2 + 20}" r="380" fill="${PALETTE.cream}" opacity="0.35"/>` : ''}
  <ellipse cx="${cx}" cy="${bodyY + bodyH + 18}" rx="${bodyW * 0.62}" ry="26" fill="${PALETTE.espresso}" opacity="0.10"/>
  <rect x="${cx - bodyW / 2}" y="${bodyY}" width="${bodyW}" height="${bodyH}" rx="${bodyW * 0.09}" fill="${art.bottle}"/>
  <rect x="${cx - bodyW / 2}" y="${bodyY}" width="${bodyW * 0.28}" height="${bodyH}" rx="${bodyW * 0.09}" fill="${PALETTE.cream}" opacity="0.28"/>
  <rect x="${cx - bodyW * 0.16}" y="${bodyY - capH}" width="${bodyW * 0.32}" height="${capH}" rx="10" fill="${art.cap}"/>
  <rect x="${cx - bodyW * 0.2}" y="${bodyY - capH - 16}" width="${bodyW * 0.4}" height="20" rx="8" fill="${art.cap}"/>
  <rect x="${cx - bodyW * 0.34}" y="${bodyY + bodyH * 0.34}" width="${bodyW * 0.68}" height="${bodyH * 0.34}" fill="${PALETTE.cream}" opacity="0.92"/>
  <text x="${cx}" y="${bodyY + bodyH * 0.47}" font-family="Georgia, 'Times New Roman', serif" font-size="34" letter-spacing="9" fill="${PALETTE.espresso}" text-anchor="middle">VEYLOR</text>
  <line x1="${cx - 46}" y1="${bodyY + bodyH * 0.52}" x2="${cx + 46}" y2="${bodyY + bodyH * 0.52}" stroke="${art.cap}" stroke-width="2"/>
  <text x="${cx}" y="${bodyY + bodyH * 0.60}" font-family="Georgia, 'Times New Roman', serif" font-size="30" fill="${PALETTE.warm}" text-anchor="middle">${label}</text>
  <text x="${cx}" y="${bodyY + bodyH * 0.655}" font-family="Helvetica, Arial, sans-serif" font-size="19" letter-spacing="3" fill="${PALETTE.stone}" text-anchor="middle">${netQuantity}</text>
</svg>`;
}

async function writeImage(dir: string, key: string, svg: string): Promise<number> {
  const absolute = path.join(dir, key);
  fs.mkdirSync(path.dirname(absolute), { recursive: true });
  const buffer = await sharp(Buffer.from(svg)).jpeg({ quality: 88, chromaSubsampling: '4:4:4' }).toBuffer();
  fs.writeFileSync(absolute, buffer);
  return buffer.length;
}

// ── helpers ──────────────────────────────────────────────────────────────────

async function idOf(sql: string, params: unknown[]): Promise<number | null> {
  const row = await queryOne<RowDataPacket & { id: number }>(sql, params);
  return row ? Number(row.id) : null;
}

/**
 * The store this catalogue belongs to: SEED_SHOP (a handle), or the founding
 * store. Everything below runs inside that store's tenancy context, so the
 * isolation guard checks every statement exactly as it does in the API.
 */
async function targetShop(): Promise<ShopContext> {
  const handle = process.env.SEED_SHOP?.trim().toLowerCase();
  const shop = handle ? await shopDirectory.byHandle(handle) : await shopDirectory.byId(1);
  if (!shop) throw new Error(handle ? `SEED_SHOP=${handle} does not match any store.` : 'No founding store (id 1). Set SEED_SHOP.');
  return shop;
}

async function main(): Promise<void> {
  await verifyConnection();
  const shop = await targetShop();
  await tenancy.run(shop, () => seed(shop));
}

async function seed(shop: ShopContext): Promise<void> {
  const root = env.storage.localRoot;
  const today = new Date().toISOString().slice(0, 10).replace(/-/g, '/');
  const SHOP_ID = shop.id;

  process.stdout.write(`Seeding the demo catalogue into ${shop.handle}\n\n`);

  const location = await idOf(
    'SELECT id FROM inventory_locations WHERE shop_id = ? AND is_active = 1 ORDER BY is_default DESC, id LIMIT 1',
    [SHOP_ID],
  );
  if (!location) throw new Error(`${shop.handle} has no inventory location to put stock in.`);

  await withTransaction(async (tx) => {
    // ── 1. retire the smoke-test noise ───────────────────────────────────────
    // Soft delete, not DELETE: orders and carts in this database point at these
    // rows, and a seed script has no business breaking referential history.
    const junk = await execute(
      `UPDATE products SET deleted_at = NOW(), status = 'archived'
        WHERE shop_id = ? AND deleted_at IS NULL
          AND (name LIKE 'UI Smoke%' OR name LIKE 'Incomplete draft%' OR name LIKE 'Smoke %')`,
      [SHOP_ID],
      tx,
    );
    await execute(
      `UPDATE categories SET deleted_at = NOW(), is_active = 0
        WHERE shop_id = ? AND deleted_at IS NULL AND (name REGEXP '[0-9]{10}' OR name LIKE 'Smoke %')`,
      [SHOP_ID],
      tx,
    );
    await execute(
      `UPDATE collections SET deleted_at = NOW(), is_active = 0
        WHERE shop_id = ? AND deleted_at IS NULL AND (title LIKE 'Smoke %' OR title LIKE 'UI Smoke%' OR slug LIKE '%-17%')`,
      [SHOP_ID],
      tx,
    );
    process.stdout.write(`  archived ${junk.affectedRows} test products\n`);

    // ── 2. tax class ─────────────────────────────────────────────────────────
    const taxClass = await queryOne<RowDataPacket & { id: number }>(
      "SELECT id FROM tax_classes WHERE shop_id = ? AND (hsn_code = '3304' OR is_default = 1) ORDER BY hsn_code = '3304' DESC LIMIT 1",
      [SHOP_ID],
      tx,
    );
    const cosmeticsTaxClassId = taxClass ? Number(taxClass.id) : null;

    // ── 2. categories ────────────────────────────────────────────────────────
    const categoryIds = new Map<string, number>();
    for (const [index, category] of CATEGORIES.entries()) {
      let id = await idOf('SELECT id FROM categories WHERE shop_id = ? AND slug = ? LIMIT 1', [SHOP_ID, category.slug]);
      if (id) {
        await execute(
          `UPDATE categories SET name = ?, description = ?, is_active = 1, show_in_menu = 1,
                  sort_order = ?, deleted_at = NULL WHERE shop_id = ? AND id = ?`,
          [category.name, category.description, index, SHOP_ID, id],
          tx,
        );
      } else {
        const result = await execute(
          `INSERT INTO categories (shop_id, parent_id, slug, name, short_description, description, path, depth,
                                   sort_order, is_active, show_in_menu)
           VALUES (?, NULL, ?, ?, ?, ?, '', 0, ?, 1, 1)`,
          [SHOP_ID, category.slug, category.name, category.description, category.description, index],
          tx,
        );
        id = result.insertId;
        // `path` is what the subtree queries walk; it can only be written once
        // the row has an id to put in it.
        await execute('UPDATE categories SET path = ? WHERE shop_id = ? AND id = ?', [String(id), SHOP_ID, id], tx);
      }
      categoryIds.set(category.slug, id);
    }
    process.stdout.write(`  ${categoryIds.size} categories\n`);

    // ── 3. products ──────────────────────────────────────────────────────────
    const productIds = new Map<string, number>();

    for (const seed of PRODUCTS) {
      const categoryId = categoryIds.get(seed.category)!;
      const prices = seed.variants.map((variant) => variant.price);
      const minPrice = Math.min(...prices);
      const maxPrice = Math.max(...prices);

      const columns = {
        slug: seed.slug,
        name: seed.name,
        subtitle: seed.subtitle,
        category_id: categoryId,
        product_type: seed.variants.length > 1 ? 'variable' : 'simple',
        status: 'active',
        visibility: 'public',
        short_description: seed.shortDescription,
        description: seed.description,
        texture: seed.texture,
        scent: seed.scent,
        fragrance_disclosure: 'No added fragrance. Contains no allergens requiring declaration.',
        suitability_note: seed.suitability,
        patch_test_note: seed.patchTest,
        routine_position: seed.routine,
        time_of_day: seed.timeOfDay,
        full_inci: seed.inci,
        manufacturer_name: 'Veylor Labs Private Limited',
        manufacturer_address: 'Plot 44, Baddi Industrial Area, Solan, Himachal Pradesh 173205',
        marketed_by_name: 'Veylor Labs Private Limited',
        marketed_by_address: '2nd Floor, Indiranagar 100 Ft Road, Bengaluru, Karnataka 560038',
        country_of_origin: 'India',
        // HSN rides on the tax class, and without one every invoice line prints
        // "—" where the code is legally required.
        tax_class_id: cosmeticsTaxClassId,
        customer_care_contact: 'care@veylor.com · 1800 200 4455',
        shelf_life_months: seed.shelfLifeMonths,
        pao_months: seed.paoMonths,
        storage_instructions: 'Store below 25°C, away from direct sunlight.',
        is_new: seed.isNew ? 1 : 0,
        is_bestseller: seed.isBestseller ? 1 : 0,
        badge: seed.badge ?? null,
        rating_average: seed.rating,
        rating_count: seed.reviewCount,
        review_count: seed.reviewCount,
        total_sold: seed.totalSold,
        min_price: minPrice,
        max_price: maxPrice,
        in_stock: 1,
        requires_shipping: 1,
      };

      let productId = await idOf('SELECT id FROM products WHERE shop_id = ? AND slug = ? LIMIT 1', [SHOP_ID, seed.slug]);
      if (productId) {
        const sets = Object.keys(columns).map((key) => `${key} = ?`).join(', ');
        await execute(
          `UPDATE products SET ${sets}, deleted_at = NULL, published_at = COALESCE(published_at, NOW()) WHERE shop_id = ? AND id = ?`,
          [...Object.values(columns), SHOP_ID, productId],
          tx,
        );
      } else {
        const keys = Object.keys(columns);
        const result = await execute(
          `INSERT INTO products (shop_id, ${keys.join(', ')}, published_at)
           VALUES (?, ${keys.map(() => '?').join(', ')}, NOW())`,
          [SHOP_ID, ...Object.values(columns)],
          tx,
        );
        productId = result.insertId;
      }
      productIds.set(seed.slug, productId);

      // ── variants + stock ───────────────────────────────────────────────────
      let defaultVariantId: number | null = null;
      for (const [position, variant] of seed.variants.entries()) {
        let variantId = await idOf('SELECT id FROM product_variants WHERE shop_id = ? AND sku = ? LIMIT 1', [SHOP_ID, variant.sku]);
        const variantColumns = {
          product_id: productId,
          sku: variant.sku,
          variant_title: variant.title,
          net_quantity: variant.netQuantity,
          volume_ml: variant.volumeMl,
          weight_grams: Math.round(variant.volumeMl * 1.1) + 60,
          mrp: variant.mrp,
          price: variant.price,
          cost_price: Math.round(variant.price * 0.32),
          position,
          is_default: variant.isDefault ? 1 : 0,
          status: 'active',
          track_inventory: 1,
          low_stock_threshold: 8,
          max_per_order: 6,
        };
        if (variantId) {
          const sets = Object.keys(variantColumns).map((key) => `${key} = ?`).join(', ');
          await execute(
            `UPDATE product_variants SET ${sets}, deleted_at = NULL WHERE shop_id = ? AND id = ?`,
            [...Object.values(variantColumns), SHOP_ID, variantId],
            tx,
          );
        } else {
          const keys = Object.keys(variantColumns);
          const result = await execute(
            `INSERT INTO product_variants (shop_id, ${keys.join(', ')}) VALUES (?, ${keys.map(() => '?').join(', ')})`,
            [SHOP_ID, ...Object.values(variantColumns)],
            tx,
          );
          variantId = result.insertId;
        }
        if (variant.isDefault) defaultVariantId = variantId;

        // quantity_available is generated (on_hand − reserved), so only the two
        // real numbers get written.
        await execute(
          `INSERT INTO inventory_items (shop_id, variant_id, location_id, quantity_on_hand, quantity_reserved, safety_stock)
           VALUES (?, ?, ?, ?, 0, 5)
           ON DUPLICATE KEY UPDATE quantity_on_hand = VALUES(quantity_on_hand)`,
          [SHOP_ID, variantId, location, variant.stock],
          tx,
        );
      }
      if (defaultVariantId) {
        await execute('UPDATE products SET default_variant_id = ? WHERE shop_id = ? AND id = ?', [defaultVariantId, SHOP_ID, productId], tx);
      }

      // ── imagery ────────────────────────────────────────────────────────────
      const existingImages = await queryOne<RowDataPacket & { count: number }>(
        `SELECT COUNT(*) AS count FROM media_attachments
          WHERE shop_id = ? AND attachable_type = 'product' AND attachable_id = ? AND collection = 'gallery'`,
        [SHOP_ID, productId],
        tx,
      );
      if (Number(existingImages?.count ?? 0) === 0) {
        for (const [index, wide] of [false, true].entries()) {
          const key = `products/${today}/${seed.slug}-${index + 1}-${randomUUID().slice(0, 8)}.jpg`;
          const svg = bottleSvg(seed.art, seed.name, seed.variants[0].netQuantity, wide);
          const bytes = await writeImage(root, key, svg);
          const media = await execute(
            `INSERT INTO media (shop_id, disk, storage_key, original_filename, extension, mime_type, media_type,
                                size_bytes, width, height, alt_text, title, usage_rights, status, source)
             VALUES (?, 'local', ?, ?, 'jpg', 'image/jpeg', 'image', ?, ?, ?, ?, ?, 'owned', 'ready', 'seed')`,
            [
              SHOP_ID,
              key,
              `${seed.slug}-${index + 1}.jpg`,
              bytes,
              1200,
              wide ? 1200 : 1500,
              `${seed.name} — ${seed.subtitle}`,
              seed.name,
            ],
            tx,
          );
          await execute(
            `INSERT INTO media_attachments (shop_id, media_id, attachable_type, attachable_id, collection, sort_order, is_primary)
             VALUES (?, ?, 'product', ?, 'gallery', ?, ?)`,
            [SHOP_ID, media.insertId, productId, index, index === 0 ? 1 : 0],
            tx,
          );
        }
      }

      // ── SEO ────────────────────────────────────────────────────────────────
      await execute(
        `INSERT INTO seo_meta (shop_id, entity_type, entity_id, locale, meta_title, meta_description,
                               twitter_card, robots_index, robots_follow, sitemap_priority, sitemap_changefreq)
         VALUES (?, 'product', ?, 'en', ?, ?, 'summary_large_image', 1, 1, 0.8, 'weekly')
         ON DUPLICATE KEY UPDATE meta_title = VALUES(meta_title), meta_description = VALUES(meta_description)`,
        [SHOP_ID, productId, seed.metaTitle, seed.metaDescription],
        tx,
      );

      process.stdout.write(`  ✓ ${seed.name}\n`);
    }

    // ── 4. collections ───────────────────────────────────────────────────────
    for (const [index, collection] of COLLECTIONS.entries()) {
      let collectionId = await idOf('SELECT id FROM collections WHERE shop_id = ? AND slug = ? LIMIT 1', [SHOP_ID, collection.slug]);
      if (collectionId) {
        await execute(
          `UPDATE collections SET title = ?, subtitle = ?, description = ?, is_active = 1, show_in_menu = 1,
                  sort_order = ?, deleted_at = NULL, published_at = COALESCE(published_at, NOW()) WHERE shop_id = ? AND id = ?`,
          [collection.title, collection.subtitle, collection.description, index, SHOP_ID, collectionId],
          tx,
        );
      } else {
        const result = await execute(
          `INSERT INTO collections (shop_id, slug, title, subtitle, description, meta_title, meta_description,
                                    collection_type, match_condition, sort_type, is_active, show_in_menu,
                                    sort_order, published_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, 'manual', 'all', 'manual', 1, 1, ?, NOW())`,
          [
            SHOP_ID,
            collection.slug,
            collection.title,
            collection.subtitle,
            collection.description,
            `${collection.title} | ${shop.name}`,
            collection.subtitle,
            index,
          ],
          tx,
        );
        collectionId = result.insertId;
      }

      await execute('DELETE FROM collection_products WHERE shop_id = ? AND collection_id = ?', [SHOP_ID, collectionId], tx);
      for (const [position, slug] of collection.products.entries()) {
        const productId = productIds.get(slug);
        if (!productId) continue;
        await execute(
          'INSERT INTO collection_products (shop_id, collection_id, product_id, position) VALUES (?, ?, ?, ?)',
          [SHOP_ID, collectionId, productId, position],
          tx,
        );
      }
      await execute(
        `UPDATE collections SET product_count = (SELECT COUNT(*) FROM collection_products WHERE shop_id = ? AND collection_id = ?)
          WHERE shop_id = ? AND id = ?`,
        [SHOP_ID, collectionId, SHOP_ID, collectionId],
        tx,
      );
      process.stdout.write(`  ✓ collection — ${collection.title}\n`);
    }
  });

  process.stdout.write(`\nDone. ${PRODUCTS.length} products, ${COLLECTIONS.length} collections.\n`);
}

main()
  .catch((error: unknown) => {
    process.stderr.write(`\nSeed failed: ${error instanceof Error ? error.stack : String(error)}\n`);
    process.exitCode = 1;
  })
  .finally(() => void closePool());
