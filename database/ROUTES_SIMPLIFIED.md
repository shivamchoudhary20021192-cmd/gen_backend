# Simplified Routes Change Summary

## Changes Made

### Database (30_fix_menu_active_match.sql)
Two routes simplified to root level:

1. **Segments**: `/customers/segments` → `/segments`
   - Parent ID remains `16` (Customers)
   
2. **Abandoned Carts**: `/orders/abandoned` → `/abandoned`
   - Parent ID remains `2` (Orders)

### Frontend Routes (App.tsx)
```typescript
// Segments - CHANGED
<Route path="segments" element={<SegmentsPage />} />
<Route path="segments/new" element={<SegmentFormPage />} />
<Route path="segments/:id" element={<SegmentDetailPage />} />
<Route path="segments/:id/edit" element={<SegmentFormPage />} />

// Abandoned Carts - CHANGED  
<Route path="abandoned" element={<AbandonedCartsPage />} />
```

## URL Changes

### Segments
| Old URL | New URL |
|---------|---------|
| `/customers/segments` | `/segments` |
| `/customers/segments/new` | `/segments/new` |
| `/customers/segments/123` | `/segments/123` |
| `/customers/segments/123/edit` | `/segments/123/edit` |

### Abandoned Carts
| Old URL | New URL |
|---------|---------|
| `/orders/abandoned` | `/abandoned` |

## Menu Structure (Parents Unchanged)
```
Orders (parent_id = 2)
├── All orders (/orders)
├── Abandoned carts (/abandoned) ← Simplified route
├── Returns (/returns)
├── Shipments (/shipments)
└── Invoices (/invoices)

Customers (parent_id = 16)
├── All customers (/customers)
└── Segments (/segments) ← Simplified route
```

## Active Highlighting Fixed
- `/orders` → Only "All orders" highlights
- `/abandoned` → Only "Abandoned carts" highlights ✅
- `/customers` → Only "All customers" highlights
- `/segments` → Only "Segments" highlights ✅

## Migration Steps

1. Run database migration:
```bash
mysql -u root -p veylog_db < database/30_fix_menu_active_match.sql
```

2. Frontend already updated

3. Test URLs:
   - http://localhost:5173/segments
   - http://localhost:5173/abandoned

## Pattern Consistency

All child routes at root level, grouped in sidebar via `parent_id`:

**Orders Module:**
- `/orders` (parent, All orders)
- `/abandoned` (child, Abandoned carts)
- `/shipments` (child)
- `/returns` (child)
- `/invoices` (child)

**Products Module:**
- `/products` (parent, All products)
- `/inventory` (child)
- `/categories` (child)
- `/collections` (child)

**Customers Module:**
- `/customers` (parent, All customers)
- `/segments` (child)
