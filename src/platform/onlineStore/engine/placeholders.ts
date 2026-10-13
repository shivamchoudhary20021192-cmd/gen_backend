/**
 * Shopify's `placeholder_svg_tag`: what a section shows in place of an image
 * or product that has not been chosen yet. A new store renders a complete,
 * good-looking home page before it has a single product — and the merchant
 * sees exactly where their own images will go.
 */

const SHAPES: Record<string, (fg: string) => string> = {
  image: (fg) => `<path fill="${fg}" d="M60 150 L130 80 L180 130 L220 95 L300 150 Z"/><circle fill="${fg}" cx="245" cy="55" r="18"/>`,
  lifestyle: (fg) => `<circle fill="${fg}" cx="160" cy="68" r="28"/><path fill="${fg}" d="M110 170 Q160 90 210 170 Z"/><rect fill="${fg}" x="40" y="150" width="240" height="6" rx="3"/>`,
  product: (fg) => `<rect fill="${fg}" x="125" y="45" width="70" height="110" rx="12"/><rect fill="${fg}" x="140" y="28" width="40" height="22" rx="4"/>`,
  collection: (fg) => `<rect fill="${fg}" x="70" y="60" width="60" height="90" rx="8"/><rect fill="${fg}" x="140" y="45" width="60" height="105" rx="8"/><rect fill="${fg}" x="210" y="70" width="45" height="80" rx="8"/>`,
  apparel: (fg) => `<path fill="${fg}" d="M120 40 L145 30 Q160 45 175 30 L200 40 L225 75 L205 88 L198 78 L198 160 L122 160 L122 78 L115 88 L95 75 Z"/>`,
  electronics: (fg) => `<rect fill="${fg}" x="90" y="45" width="140" height="90" rx="8"/><rect fill="${fg}" x="140" y="140" width="40" height="10"/><rect fill="${fg}" x="120" y="150" width="80" height="6" rx="3"/>`,
  food: (fg) => `<ellipse fill="${fg}" cx="160" cy="120" rx="90" ry="30"/><circle fill="${fg}" cx="130" cy="95" r="22"/><circle fill="${fg}" cx="175" cy="88" r="26"/>`,
  home: (fg) => `<rect fill="${fg}" x="80" y="95" width="160" height="45" rx="10"/><rect fill="${fg}" x="70" y="80" width="30" height="70" rx="8"/><rect fill="${fg}" x="220" y="80" width="30" height="70" rx="8"/>`,
  jewelry: (fg) => `<circle fill="none" stroke="${fg}" stroke-width="10" cx="160" cy="105" r="42"/><path fill="${fg}" d="M145 45 L160 30 L175 45 L160 70 Z"/>`,
  book: (fg) => `<path fill="${fg}" d="M70 50 Q115 40 158 55 L158 160 Q115 145 70 155 Z"/><path fill="${fg}" d="M162 55 Q205 40 250 50 L250 155 Q205 145 162 160 Z"/>`,
  sport: (fg) => `<circle fill="none" stroke="${fg}" stroke-width="10" cx="160" cy="100" r="50"/><path stroke="${fg}" stroke-width="8" fill="none" d="M110 100 H210 M160 50 V150"/>`,
  logo: (fg) => `<rect fill="${fg}" x="95" y="80" width="130" height="40" rx="20"/>`,
};

const VARIANTS: Record<string, string> = {
  'product-1': 'product', 'product-2': 'apparel', 'product-3': 'electronics', 'product-4': 'home', 'product-5': 'jewelry', 'product-6': 'book',
  'collection-1': 'collection', 'collection-2': 'apparel', 'collection-3': 'food', 'collection-4': 'home', 'collection-5': 'sport', 'collection-6': 'jewelry',
  'lifestyle-1': 'lifestyle', 'lifestyle-2': 'lifestyle', 'image': 'image', 'hero-apparel-1': 'apparel', 'hero-apparel-2': 'apparel', 'detailed-apparel-1': 'apparel',
  'logo': 'logo',
};

export function placeholderSvg(name: string, className?: string): string {
  const shape = SHAPES[VARIANTS[name] ?? name] ?? SHAPES.image;
  const cls = className ? ` class="${className.replace(/"/g, '')}"` : '';
  return `<svg${cls} xmlns="http://www.w3.org/2000/svg" viewBox="0 0 320 190" preserveAspectRatio="xMidYMid slice" role="img" aria-label="Placeholder"><rect width="320" height="190" fill="currentColor" opacity="0.06"/><g opacity="0.22">${shape('currentColor')}</g></svg>`;
}
