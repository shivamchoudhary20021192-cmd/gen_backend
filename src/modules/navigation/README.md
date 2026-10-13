# CMS Navigation Module

Complete storefront navigation management system with drag-and-drop reordering, hierarchical menu structure, and multiple link types.

## Overview

This module provides admin APIs for managing `cms_menus` and `cms_menu_items` tables, enabling creation of complex navigation menus with nested items, various link types, and media integration for mega-menus.

## Features

- ✅ **Hierarchical Menu Structure**: Unlimited nesting with parent-child relationships
- ✅ **10 Link Types**: URL, Page, Category, Collection, Product, Article, Policy, Ingredient, Routine, None
- ✅ **Drag-and-Drop Reordering**: Bulk reorder API with circular reference prevention
- ✅ **Media Integration**: Icon and image support for menu items
- ✅ **System Menu Protection**: Prevent deletion of essential menus
- ✅ **Slug Auto-generation**: Automatic kebab-case slug creation
- ✅ **Tree Building**: Flat storage with hierarchical retrieval
- ✅ **Link Resolution**: Resolve entity references to URLs

## Database Schema

### cms_menus
```sql
CREATE TABLE cms_menus (
  id SERIAL PRIMARY KEY,
  slug VARCHAR(140) UNIQUE NOT NULL,
  name VARCHAR(100) NOT NULL,
  is_active BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
```

### cms_menu_items
```sql
CREATE TABLE cms_menu_items (
  id SERIAL PRIMARY KEY,
  menu_id INTEGER NOT NULL REFERENCES cms_menus(id) ON DELETE CASCADE,
  parent_id INTEGER REFERENCES cms_menu_items(id) ON DELETE CASCADE,
  label VARCHAR(100) NOT NULL,
  link_type link_type_enum NOT NULL,
  link_ref_id INTEGER,
  url TEXT,
  icon_media_id INTEGER REFERENCES media(id) ON DELETE SET NULL,
  image_media_id INTEGER REFERENCES media(id) ON DELETE SET NULL,
  badge_label VARCHAR(50),
  description TEXT,
  sort_order INTEGER NOT NULL DEFAULT 0,
  opens_new_tab BOOLEAN NOT NULL DEFAULT false,
  is_active BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TYPE link_type_enum AS ENUM (
  'url', 'page', 'category', 'collection', 'product',
  'article', 'policy', 'ingredient', 'routine', 'none'
);
```

## API Endpoints

### Menus

| Method | Endpoint | Description | Permission |
|--------|----------|-------------|------------|
| GET | `/admin/api/v1/cms/menus` | List all menus | content.navigation.read |
| POST | `/admin/api/v1/cms/menus` | Create menu | content.navigation.create |
| GET | `/admin/api/v1/cms/menus/slug/:slug` | Get menu by slug | content.navigation.read |
| GET | `/admin/api/v1/cms/menus/:id` | Get menu by ID | content.navigation.read |
| GET | `/admin/api/v1/cms/menus/:id/items` | Get menu with tree structure | content.navigation.read |
| PUT | `/admin/api/v1/cms/menus/:id` | Update menu | content.navigation.update |
| DELETE | `/admin/api/v1/cms/menus/:id` | Delete menu | content.navigation.delete |

### Menu Items

| Method | Endpoint | Description | Permission |
|--------|----------|-------------|------------|
| GET | `/admin/api/v1/cms/menu-items` | List menu items (filtered) | content.navigation.read |
| POST | `/admin/api/v1/cms/menu-items` | Create menu item | content.navigation.create |
| POST | `/admin/api/v1/cms/menu-items/bulk-reorder` | Bulk reorder items | content.navigation.update |
| GET | `/admin/api/v1/cms/menu-items/:id` | Get menu item by ID | content.navigation.read |
| PUT | `/admin/api/v1/cms/menu-items/:id` | Update menu item | content.navigation.update |
| DELETE | `/admin/api/v1/cms/menu-items/:id` | Delete menu item | content.navigation.delete |

## Usage Examples

### Create Menu
```bash
POST /admin/api/v1/cms/menus
Content-Type: application/json

{
  "name": "Main Navigation",
  "slug": "main",
  "is_active": true
}
```

### Create Menu Item
```bash
POST /admin/api/v1/cms/menu-items
Content-Type: application/json

{
  "menu_id": 1,
  "label": "Shop",
  "link_type": "collection",
  "link_ref_id": 5,
  "parent_id": null,
  "sort_order": 0,
  "is_active": true
}
```

### Create Nested Item
```bash
POST /admin/api/v1/cms/menu-items
Content-Type: application/json

{
  "menu_id": 1,
  "label": "New Arrivals",
  "link_type": "collection",
  "link_ref_id": 12,
  "parent_id": 1,
  "badge_label": "New",
  "sort_order": 0,
  "is_active": true
}
```

### Create External URL Item
```bash
POST /admin/api/v1/cms/menu-items
Content-Type: application/json

{
  "menu_id": 1,
  "label": "Blog",
  "link_type": "url",
  "url": "https://blog.example.com",
  "opens_new_tab": true,
  "is_active": true
}
```

### Get Menu with Tree Structure
```bash
GET /admin/api/v1/cms/menus/1/items

Response:
{
  "success": true,
  "data": {
    "id": 1,
    "slug": "main",
    "name": "Main Navigation",
    "is_active": true,
    "items": [
      {
        "id": 1,
        "label": "Shop",
        "link_type": "collection",
        "link_ref_id": 5,
        "parent_id": null,
        "sort_order": 0,
        "children": [
          {
            "id": 2,
            "label": "New Arrivals",
            "link_type": "collection",
            "link_ref_id": 12,
            "parent_id": 1,
            "badge_label": "New",
            "sort_order": 0,
            "children": []
          }
        ]
      }
    ]
  }
}
```

### Bulk Reorder Items (Drag-and-Drop)
```bash
POST /admin/api/v1/cms/menu-items/bulk-reorder
Content-Type: application/json

{
  "updates": [
    { "id": 1, "parent_id": null, "sort_order": 0 },
    { "id": 2, "parent_id": 1, "sort_order": 0 },
    { "id": 3, "parent_id": 1, "sort_order": 10 },
    { "id": 4, "parent_id": null, "sort_order": 10 }
  ]
}
```

## Link Types

### 1. url
External URL link. Requires `url` field.
```json
{
  "link_type": "url",
  "url": "https://example.com"
}
```

### 2. page
CMS page reference. Requires `link_ref_id` pointing to `cms_pages.id`.
```json
{
  "link_type": "page",
  "link_ref_id": 5
}
```

### 3. category
Product category reference. Requires `link_ref_id` pointing to `categories.id`.
```json
{
  "link_type": "category",
  "link_ref_id": 10
}
```

### 4. collection
Product collection reference. Requires `link_ref_id` pointing to `collections.id`.
```json
{
  "link_type": "collection",
  "link_ref_id": 3
}
```

### 5. product
Product reference. Requires `link_ref_id` pointing to `products.id`.
```json
{
  "link_type": "product",
  "link_ref_id": 42
}
```

### 6. article
Article reference. Requires `link_ref_id` pointing to `cms_articles.id`.
```json
{
  "link_type": "article",
  "link_ref_id": 8
}
```

### 7. policy
Policy page reference. Requires `link_ref_id` pointing to `cms_pages.id` (with type filter).
```json
{
  "link_type": "policy",
  "link_ref_id": 15
}
```

### 8. ingredient
Ingredient reference. Requires `link_ref_id` pointing to `ingredients.id`.
```json
{
  "link_type": "ingredient",
  "link_ref_id": 7
}
```

### 9. routine
Routine reference. Requires `link_ref_id` pointing to `routines.id`.
```json
{
  "link_type": "routine",
  "link_ref_id": 4
}
```

### 10. none
Non-clickable parent item (for mega-menu headers).
```json
{
  "link_type": "none"
}
```

## System Menus

The following menus are protected from deletion:
- `main` - Main navigation
- `footer` - Footer navigation
- `mobile_drawer` - Mobile drawer menu
- `footer_shop` - Footer shop links
- `footer_support` - Footer support links

## Circular Reference Prevention

The module prevents circular references in parent-child relationships:

```typescript
// Backend validation in service layer
async function wouldCreateCycle(
  itemId: number,
  newParentId: number | null,
  conn?: PoolClient
): Promise<boolean> {
  if (!newParentId) return false
  if (itemId === newParentId) return true

  let currentParentId = newParentId
  const visited = new Set<number>([itemId])

  while (currentParentId) {
    if (visited.has(currentParentId)) return true
    visited.add(currentParentId)

    const parent = await cmsMenuItemsRepository.getById(currentParentId, conn)
    if (!parent) break
    currentParentId = parent.parent_id
  }

  return false
}
```

## Tree Building

Menu items are stored flat in the database but retrieved as hierarchical trees:

```typescript
function buildTree(items: MenuItemWithMedia[]): MenuItemTreeNode[] {
  const itemMap = new Map<number, MenuItemTreeNode>()
  const rootItems: MenuItemTreeNode[] = []

  // Create tree nodes
  items.forEach((item) => {
    itemMap.set(item.id, { ...item, children: [] })
  })

  // Build hierarchy
  items.forEach((item) => {
    const node = itemMap.get(item.id)!
    if (item.parent_id === null) {
      rootItems.push(node)
    } else {
      const parent = itemMap.get(item.parent_id)
      if (parent) {
        parent.children.push(node)
      } else {
        rootItems.push(node)
      }
    }
  })

  // Sort by sort_order
  function sortChildren(nodes: MenuItemTreeNode[]) {
    nodes.sort((a, b) => a.sort_order - b.sort_order)
    nodes.forEach((node) => {
      if (node.children.length > 0) {
        sortChildren(node.children)
      }
    })
  }

  sortChildren(rootItems)
  return rootItems
}
```

## Frontend Integration

### Installation
```bash
# Install drag-and-drop dependencies
npm install @dnd-kit/core @dnd-kit/sortable @dnd-kit/utilities
```

### Usage
```typescript
import { MenusListPage, MenuItemsManagePage } from '@/features/navigation'

// In your router
<Route path="/navigation/menus" element={<MenusListPage />} />
<Route path="/navigation/menus/:menuId/items" element={<MenuItemsManagePage />} />
```

### React Query Hooks
```typescript
import {
  useMenus,
  useMenuWithItems,
  useCreateMenuItem,
  useUpdateMenuItem,
  useDeleteMenuItem,
  useBulkReorderMenuItems,
} from '@/features/navigation'

// List menus
const { data: menus } = useMenus({ is_active: true })

// Get menu with tree
const { data: menuWithItems } = useMenuWithItems(menuId)

// Create item
const createMutation = useCreateMenuItem()
await createMutation.mutateAsync({
  menu_id: 1,
  label: 'New Item',
  link_type: 'url',
  url: 'https://example.com',
})

// Bulk reorder after drag-and-drop
const bulkReorder = useBulkReorderMenuItems()
await bulkReorder.mutateAsync({ updates })
```

## Validation Rules

### Menus
- `name`: Required, max 100 characters
- `slug`: Optional (auto-generated), max 140 characters, kebab-case, unique
- `is_active`: Boolean, defaults to true

### Menu Items
- `label`: Required, max 100 characters
- `link_type`: Required, one of 10 enum values
- `url`: Required if link_type='url', must be valid URL
- `link_ref_id`: Required if link_type != 'url' and != 'none'
- `parent_id`: Optional, must exist, cannot create circular reference
- `badge_label`: Optional, max 50 characters
- `description`: Optional, for mega-menu descriptions
- `sort_order`: Integer 0-65535, auto-assigned if omitted
- `opens_new_tab`: Boolean, defaults to false
- `is_active`: Boolean, defaults to true

## Performance Considerations

1. **Indexing**: Database has indexes on menu_id, parent_id, sort_order
2. **Cascade Deletes**: Deleting a menu cascades to all items
3. **Tree Depth**: No hard limit, but recommend max 3 levels for UX
4. **Bulk Operations**: Bulk reorder supports up to 500 items per request

## Error Handling

Common error responses:

```json
// Menu not found
{
  "success": false,
  "message": "Menu not found"
}

// Slug already exists
{
  "success": false,
  "message": "Menu with slug 'main' already exists"
}

// Circular reference
{
  "success": false,
  "message": "Cannot set parent: would create circular reference"
}

// Invalid link type
{
  "success": false,
  "message": "link_type 'url' requires url field"
}

// System menu protection
{
  "success": false,
  "message": "Cannot delete system menu 'main'"
}
```

## Testing

### Smoke Test Script
```bash
# Run smoke test
npx tsx scripts/smoke-navigation.ts
```

### Manual Testing Checklist
- [ ] Create menu with auto-slug generation
- [ ] Create menu items with all 10 link types
- [ ] Create nested items (3+ levels deep)
- [ ] Drag-and-drop reorder items
- [ ] Move item to different parent
- [ ] Attempt circular reference (should fail)
- [ ] Delete item with children
- [ ] Attempt delete system menu (should fail)
- [ ] Update menu and item fields
- [ ] Toggle is_active on menu and items

## Migration Notes

If adding to existing project:
1. Run database migrations in order (database/14_navigation.sql)
2. Add permissions to admin roles (content.navigation.*)
3. Configure menu seeds if needed (database/99b_navigation_seed.sql)
4. Update frontend routing to include navigation pages
5. Install @dnd-kit dependencies for drag-and-drop

## Future Enhancements

- [ ] Menu item templates/presets
- [ ] Import/export menu configurations
- [ ] Menu versioning and rollback
- [ ] A/B testing for different menu structures
- [ ] Analytics integration for menu item clicks
- [ ] Visual mega-menu builder
- [ ] Menu item scheduling (show/hide by date)
- [ ] Multi-language menu support

## Troubleshooting

### Items not appearing in tree
- Check parent_id relationships are valid
- Verify is_active status
- Check menu_id matches

### Drag-and-drop not working
- Verify @dnd-kit packages installed
- Check flatItems array is properly generated
- Ensure unique IDs in SortableContext

### Circular reference errors
- Review parent-child relationships
- Use wouldCreateCycle utility before updates
- Check for orphaned items with invalid parent_id

---

**Module Version**: 1.0.0  
**Last Updated**: 2026-09-10  
**Maintained By**: Veylog Development Team
