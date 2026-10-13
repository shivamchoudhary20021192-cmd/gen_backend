# Menu Routing & Active Match Patterns

## Problem
When navigating to child routes like `/customers/segments`, both the parent "Customers" and child "Segments" menu items were highlighting.

## Solution
Use regex patterns in `active_match` field to ensure only ONE menu item highlights at a time.

## Pattern Reference

### Parent Items (Top-level with dropdowns)

#### Products Pattern ✅
```
Parent: Products
├─ Route: /products
├─ Active Match: /products$
└─ Sub-items:
   ├─ All products → /products → /products(/new|/[0-9]+(/edit)?)?$
   ├─ Inventory → /inventory → /inventory
   ├─ Categories → /categories → /categories
   └─ Collections → /collections → /collections
```

**Result:**
- `/products` → Only "All products" highlights
- `/products/123` → Only "All products" highlights
- `/inventory` → Only "Inventory" highlights ✅
- Parent "Products" never highlights (it's just a dropdown)

#### Customers Pattern ✅
```
Parent: Customers
├─ Route: /customers
├─ Active Match: /customers(/[0-9]+)?$
└─ Sub-items:
   ├─ All customers → /customers → /customers(/[0-9]+)?$
   └─ Segments → /customers/segments → /customers/segments
```

**Result:**
- `/customers` → Only "All customers" highlights ✅
- `/customers/123` → Only "All customers" highlights ✅
- `/customers/segments` → Only "Segments" highlights ✅
- `/customers/segments/456` → Only "Segments" highlights ✅

#### Orders Pattern ✅
```
Parent: Orders
├─ Route: /orders
├─ Active Match: /orders$
└─ Sub-items:
   ├─ All orders → /orders → /orders$
   ├─ Abandoned carts → /orders/abandoned → /orders/abandoned
   ├─ Returns → /returns → /returns
   ├─ Shipments → /shipments → /shipments
   └─ Invoices → /invoices → /invoices
```

**Result:**
- `/orders` → Only "All orders" highlights ✅
- `/orders/123` → Nothing highlights (order detail pages don't need menu highlight)
- `/orders/abandoned` → Only "Abandoned carts" highlights ✅
- `/shipments` → Only "Shipments" highlights ✅

#### Content Pattern ✅
```
Parent: Content (no route)
├─ Route: NULL
├─ Active Match: NULL
└─ Sub-items:
   ├─ Pages → /content/pages → /content/pages
   ├─ Journal → /content/articles → /content/articles
   ├─ Banners → /content/banners → /content/banners
   ├─ FAQs → /content/faqs → /content/faqs
   └─ Menus → /content/menus → /content/menus
```

**Result:**
- `/content/pages` → Only "Pages" highlights ✅
- `/content/articles` → Only "Journal" highlights ✅
- Parent "Content" never highlights (no route) ✅

## Regex Patterns Explained

| Pattern | Meaning | Example |
|---------|---------|---------|
| `/path$` | Exact match only | `/orders$` matches `/orders` but NOT `/orders/123` |
| `/path` | Prefix match | `/orders` matches `/orders`, `/orders/123`, `/orders/abandoned` |
| `/path(/[0-9]+)?$` | Path or path with numeric ID | Matches `/customers` and `/customers/123` but NOT `/customers/segments` |
| `/path(/new\|/[0-9]+)?$` | Path, new, or ID | Matches `/products`, `/products/new`, `/products/123` |
| `NULL` | Never highlights | Used for parent-only items with no route |

## Implementation Checklist

- [x] Parent items use `$` anchor or specific patterns
- [x] Child items use full paths
- [x] "All X" items match parent route + ID routes
- [x] Special routes (segments, abandoned, etc.) have unique paths
- [x] Parent-only items (Content, Settings) have NULL active_match
- [x] Tested: Only ONE menu item highlights per route

## Testing Scenarios

### Customers Module
✅ `/customers` → Highlights "All customers"  
✅ `/customers/123` → Highlights "All customers"  
✅ `/customers/segments` → Highlights "Segments"  
✅ `/customers/segments/new` → Highlights "Segments"  
✅ `/customers/segments/456` → Highlights "Segments"  

### Products Module
✅ `/products` → Highlights "All products"  
✅ `/products/new` → Highlights "All products"  
✅ `/products/789` → Highlights "All products"  
✅ `/inventory` → Highlights "Inventory" (NOT "All products")  
✅ `/categories` → Highlights "Categories" (NOT "All products")  
✅ `/collections` → Highlights "Collections" (NOT "All products")  

### Orders Module
✅ `/orders` → Highlights "All orders"  
✅ `/orders/abandoned` → Highlights "Abandoned carts" (NOT "All orders")  
✅ `/shipments` → Highlights "Shipments" (NOT "All orders")  
✅ `/returns` → Highlights "Returns" (NOT "All orders")  
✅ `/invoices` → Highlights "Invoices" (NOT "All orders")  

### Content Module
✅ `/content/pages` → Highlights "Pages"  
✅ `/content/articles` → Highlights "Journal"  
✅ `/content/banners` → Highlights "Banners"  
✅ Parent "Content" never highlights  

## Migration File
Run `database/30_fix_menu_active_match.sql` to apply all fixes.

```bash
mysql -u root -p veylog_db < database/30_fix_menu_active_match.sql
```
