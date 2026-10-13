# Product Card Design Specification
## Inspired by Rhode Skin (rhodeskin.com)

---

## 🎨 Design Overview

Create a premium, editorial-style product card with:
- **Image hover swap** (primary → secondary image on hover)
- **Dynamic availability button** (Buy / Sold Out based on stock)
- **Badge overlays** (discount, exclusivity)
- **Wishlist/Save functionality**
- **Clean typography** with serif accents
- **Smooth animations** and transitions
- **Mobile-optimized** layout

---

## 📐 Layout Structure

### Desktop Layout (Grid View)
```
┌─────────────────────────────────────┐
│  [Badge]              [Heart Icon]  │ ← Overlay
│                                     │
│                                     │
│         PRODUCT IMAGE               │ ← Aspect ratio: 3:4
│       (Hover to swap)               │
│                                     │
│                                     │
│  ┌───────────────────────────────┐ │
│  │   BUY NOW - ₹999 / SOLD OUT  │ │ ← CTA Button
│  └───────────────────────────────┘ │
├─────────────────────────────────────┤
│  CATEGORY TAG                       │ ← Small uppercase
│  Product Name                       │ ← Larger serif font
│  Brief description or subtitle      │ ← Smaller body text
│  ₹999  ₹1,299                      │ ← Price (strike through)
└─────────────────────────────────────┘
```

### Mobile Layout (Stacked)
```
┌───────────────────┐
│  [Badge]    [♡]  │
│                   │
│   PRODUCT IMAGE   │
│                   │
│  ┌─────────────┐ │
│  │   BUY/SOLD  │ │
│  └─────────────┘ │
├───────────────────┤
│  CATEGORY         │
│  Product Name     │
│  Description      │
│  ₹999  ₹1,299    │
└───────────────────┘
```

---

## 🖼️ Image Component

### Structure
- **Primary Image**: Default visible image (product shot)
- **Secondary Image**: Lifestyle/alternate view (shown on hover)
- **Aspect Ratio**: 3:4 (portrait, matches Rhode Skin style)
- **Object Fit**: Cover (fills container, crops edges)

### Hover Behavior
```
Default State:     → Hover State:
┌─────────────┐      ┌─────────────┐
│   Primary   │      │  Secondary  │
│    Image    │  →   │    Image    │
│             │      │ (crossfade) │
└─────────────┘      └─────────────┘
```

**Animation**: 
- Duration: 400ms
- Easing: ease-in-out
- Effect: Opacity crossfade (not slide)

### Fallback
- If no secondary image → no hover effect
- If no images at all → show placeholder

---

## 🏷️ Badge Overlay

### Position
- **Desktop**: Top-left corner, 12px inset
- **Mobile**: Top-left corner, 8px inset

### Badge Types & Styling

#### Discount Badge
```
┌──────────────┐
│  20% OFF     │  Background: Sage green (#7A9B8E)
└──────────────┘  Text: White, uppercase, 10px
```

#### Exclusivity Badge  
```
┌──────────────┐
│ only at rhode│  Background: Dark grey (#4A4A4A)
└──────────────┘  Text: White, lowercase, 10px
```

#### New Badge
```
┌──────────────┐
│     NEW      │  Background: Cream (#F5E6D3)
└──────────────┘  Text: Espresso, uppercase, 10px
```

**Styling**:
- Border radius: 4px (pill shape)
- Padding: 4px 10px
- Font: Sans-serif, 600 weight
- Letter spacing: 0.5px

---

## 💚 Wishlist Heart Icon

### Position
- **Desktop**: Top-right corner, 12px inset
- **Mobile**: Top-right corner, 8px inset

### States

#### Default (Not Saved)
```
   ♡
```
- Stroke: Dark grey (#2C1810)
- Fill: Transparent
- Size: 24px

#### Hover (Not Saved)
```
   ♡
```
- Stroke: Botanical green (#7A9B8E)
- Fill: Light sage (#E8F0ED)
- Transition: 200ms

#### Active (Saved)
```
   ♥
```
- Stroke: Botanical green (#7A9B8E)
- Fill: Botanical green (#7A9B8E)
- Slight scale: 1.1

**Interaction**:
- Click toggles saved state
- Animate with scale + fade
- Show brief toast/feedback

---

## 🔘 CTA Button (Key Feature)

### Position
- Overlays bottom of image
- 16px margin from image edges
- Full width of image minus margins

### Button States

#### Available - Default
```
┌─────────────────────────────────┐
│     BUY PRODUCT NAME - ₹999     │
└─────────────────────────────────┘
Background: White
Border: 2px solid Espresso (#2C1810)
Text: Espresso, 13px uppercase
```

#### Available - Hover
```
┌─────────────────────────────────┐
│     BUY PRODUCT NAME - ₹999     │
└─────────────────────────────────┘
Background: Espresso (#2C1810)
Border: 2px solid Espresso
Text: White
Transition: 200ms
```

#### Sold Out - Default
```
┌─────────────────────────────────┐
│      SOLD OUT - ₹999            │
└─────────────────────────────────┘
Background: Light grey (#E8E8E8)
Border: 2px solid Grey (#CCCCCC)
Text: Grey (#999999)
Cursor: not-allowed
```

#### Low Stock (< 5 items)
```
┌─────────────────────────────────┐
│  BUY PRODUCT NAME - ₹999 • LOW STOCK
└─────────────────────────────────┘
Background: White
Border: 2px solid Warm orange (#D4855A)
Text: Espresso with orange indicator
```

**Styling Details**:
- Border radius: 28px (pill)
- Padding: 12px 20px
- Font weight: 600
- Letter spacing: 0.8px
- Truncate long product names with ellipsis

---

## 📝 Text Content Area

### Layout Hierarchy

```
CATEGORY TAG        ← 11px, uppercase, tracking 1.2px, grey
Product Name        ← 18px, serif/display, espresso
Description text    ← 14px, sans-serif, warm grey
₹999  ₹1,299       ← 16px, current bold, original strike
```

### Category Tag
- **Font**: Sans-serif, 600 weight
- **Size**: 11px
- **Transform**: Uppercase
- **Color**: Warm grey (#6B5D54)
- **Margin**: 8px bottom

### Product Name
- **Font**: Display/serif (like "Crimson Pro" or similar)
- **Size**: 18px (desktop), 16px (mobile)
- **Color**: Espresso (#2C1810)
- **Line height**: 1.2
- **Margin**: 6px bottom
- **Hover**: Underline decoration

### Description/Subtitle
- **Font**: Sans-serif
- **Size**: 14px
- **Color**: Warm grey (#847568)
- **Line height**: 1.4
- **Max lines**: 2 with ellipsis
- **Margin**: 8px bottom

### Price Display

#### When Product Has Discount
```
₹999  ₹1,299
────  ────────
Bold  Strikethrough
16px  14px
```

#### When No Discount
```
₹999
────
Bold
16px
```

**Styling**:
- Current price: Bold, espresso color
- Original price: Regular weight, grey, line-through
- Spacing: 8px between prices
- Rupee symbol: Always present

---

## 🎭 Interaction States

### Card Hover (Desktop Only)
```
Default State          Hover State
─────────────         ─────────────
Image: Primary   →    Image: Secondary (fade)
Button: Outlined →    Button: Filled
Shadow: None     →    Shadow: Subtle (0 4px 16px rgba(0,0,0,0.08))
Scale: 1.0       →    Scale: 1.0 (no scale, just shadow)
```

**Transition**: 400ms ease-in-out

### Button Interaction
```
Rest → Hover → Active → Focus
────   ─────   ──────   ─────
White  Black   Black    Black + ring
Border Filled  Filled   + Focus ring
```

### Wishlist Heart Animation
```
Click → Scale 1.2 → Scale back to 1.0
Duration: 300ms
Easing: spring (bounce)
```

---

## 📱 Responsive Breakpoints

### Desktop (≥1024px)
- 4 cards per row (25% width)
- Gap: 24px between cards
- Hover effects: Active
- Image swap: On hover

### Tablet (768px - 1023px)
- 3 cards per row (33.33% width)
- Gap: 20px between cards
- Hover effects: Active
- Image swap: On hover

### Mobile (≤767px)
- 2 cards per row (50% width)
- Gap: 16px between cards
- Hover effects: Disabled
- Image swap: Tap to toggle
- Reduced padding/margins

### Small Mobile (≤480px)
- 2 cards per row (still 50%)
- Gap: 12px between cards
- Smaller fonts (scale down by 10%)
- Compact button text: "BUY - ₹999"

---

## 🎨 Color Palette (Veylor Brand)

```css
/* Primary Colors */
--veylor-espresso: #2C1810;      /* Headings, dark text */
--veylor-cream: #F8F4EF;          /* Backgrounds */
--veylor-ivory: #FDFBF7;          /* Alternate bg */

/* Accent Colors */
--veylor-botanical: #7A9B8E;      /* CTA, badges */
--veylor-warm: #847568;           /* Body text */
--veylor-sage: #E8F0ED;           /* Hover states */
--veylor-champagne: #EDE0CF;      /* Borders */

/* State Colors */
--veylor-sold-out: #999999;       /* Unavailable */
--veylor-low-stock: #D4855A;      /* Warning */
--veylor-success: #6B9E8E;        /* In stock */
```

---

## ♿ Accessibility

### Keyboard Navigation
- **Tab**: Focus next card
- **Enter/Space**: 
  - On card: Navigate to product
  - On heart: Toggle wishlist
  - On button: Add to cart (if available)
- **Focus indicator**: 2px offset ring

### Screen Readers
```html
<article aria-label="Product card: GlowReset Vitamin C Serum">
  <button aria-label="Add to wishlist">...</button>
  <img alt="GlowReset Vitamin C Serum bottle on cream background" />
  <button aria-label="Buy GlowReset Vitamin C Serum for 999 rupees">
    BUY GLOWRESET - ₹999
  </button>
</article>
```

### Color Contrast
- Text on white: Minimum 4.5:1
- Button text: Minimum 4.5:1
- Badges: Minimum 3:1 for large text

---

## 📊 Data Requirements

### Product Object Structure
```typescript
interface ProductCard {
  id: number
  slug: string
  name: string
  subtitle: string | null
  short_description: string | null
  
  // Pricing
  price: number           // Current price
  mrp: number | null      // Original price
  discount_percent: number | null
  
  // Images
  image: string | null              // Primary image
  image_alt: string                 // Alt text
  hover_image: string | null        // Secondary image for hover
  
  // Stock
  in_stock: boolean
  low_stock: boolean                // < 5 items
  available_quantity: number | null
  
  // Categorization
  category: {
    slug: string
    name: string | null
  } | null
  
  // Badges
  is_new: boolean
  is_bestseller: boolean
  is_exclusive: boolean             // "only at veylor"
  badge: string | null              // Custom badge text
  
  // Metadata
  rating: number
  review_count: number
}
```

---

## 🔄 Animation Specifications

### Image Crossfade
```css
.product-image-primary {
  opacity: 1;
  transition: opacity 400ms ease-in-out;
}

.product-card:hover .product-image-primary {
  opacity: 0;
}

.product-image-secondary {
  position: absolute;
  opacity: 0;
  transition: opacity 400ms ease-in-out;
}

.product-card:hover .product-image-secondary {
  opacity: 1;
}
```

### Button Transform
```css
.product-button {
  background: white;
  color: #2C1810;
  transition: all 200ms ease;
}

.product-button:hover:not(:disabled) {
  background: #2C1810;
  color: white;
  transform: translateY(-1px);
}

.product-button:active:not(:disabled) {
  transform: translateY(0);
}
```

### Card Elevation
```css
.product-card {
  box-shadow: none;
  transition: box-shadow 300ms ease;
}

.product-card:hover {
  box-shadow: 0 8px 24px rgba(44, 24, 16, 0.08);
}
```

---

## 📦 Component Breakdown

### File Structure
```
src/components/
  ProductCard/
    ProductCard.tsx           # Main component
    ProductImage.tsx          # Image with hover swap
    ProductBadge.tsx          # Badge overlay
    ProductButton.tsx         # CTA button
    WishlistButton.tsx        # Heart icon
    ProductInfo.tsx           # Text content
    ProductCard.module.css    # Styles (optional)
```

### Component Hierarchy
```
<ProductCard>
  <ProductCardLink>
    <ProductImageContainer>
      <ProductBadge />
      <WishlistButton />
      <ProductImage primary={} secondary={} />
      <ProductButton inStock={} price={} />
    </ProductImageContainer>
    <ProductInfo>
      <ProductCategory />
      <ProductName />
      <ProductDescription />
      <ProductPrice />
    </ProductInfo>
  </ProductCardLink>
</ProductCard>
```

---

## 🎬 Implementation Priority

### Phase 1: Core Structure
1. ✅ Basic card layout
2. ✅ Image container with aspect ratio
3. ✅ Text content area
4. ✅ Responsive grid

### Phase 2: Interactive Elements
1. ✅ Hover image swap
2. ✅ CTA button with states
3. ✅ Wishlist toggle
4. ✅ Badge overlays

### Phase 3: Polish
1. ✅ Animations & transitions
2. ✅ Loading states
3. ✅ Error boundaries
4. ✅ Accessibility audit

### Phase 4: Enhancement
1. ⭕ Quick view modal
2. ⭕ Product variant selector
3. ⭕ Comparison toggle
4. ⭕ Recently viewed tracking

---

## 🧪 Testing Checklist

- [ ] Hover image swap works smoothly
- [ ] Button shows correct text (Buy/Sold Out)
- [ ] Wishlist toggle persists state
- [ ] Mobile: 2 cards per row
- [ ] Tablet: 3 cards per row
- [ ] Desktop: 4 cards per row
- [ ] Badge shows when discount exists
- [ ] Price strikethrough when MRP present
- [ ] Keyboard navigation works
- [ ] Screen reader announces correctly
- [ ] Long product names truncate properly
- [ ] Missing images show placeholder
- [ ] Sold out products disable button

---

## 📸 Visual Reference Summary

**Rhode Skin Inspiration Points:**
1. ✅ Large product title in lowercase serif at top
2. ✅ Image hover reveals lifestyle/alternate shot
3. ✅ Bottom overlay button with product name + price
4. ✅ "Sold Out" state with greyed button
5. ✅ Clean minimal aesthetic, no heavy shadows
6. ✅ Pill-shaped buttons
7. ✅ Exclusivity badges ("only at rhode")
8. ✅ Generous whitespace

**Veylor Adaptations:**
- Brand colors (espresso, cream, botanical)
- Indian pricing (₹ symbol)
- Category tags above product name
- Star rating display (optional)
- Discount percentage badges
- "Low Stock" indicator

---

**Design Status**: ✅ Complete - Ready for Implementation  
**Next Step**: Build React components based on this spec
