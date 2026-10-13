# Navigation Module - Installation Guide

Quick setup guide for integrating the CMS Navigation module into your Veylog project.

## Prerequisites

- PostgreSQL database
- Node.js backend with Express
- React frontend admin panel
- User authentication and authorization system

---

## Backend Installation

### Step 1: Database Migration

Run the navigation schema migration:

```bash
psql -U your_user -d veylog_db -f database/14_navigation.sql
```

This creates:
- `link_type_enum` enum type
- `cms_menus` table
- `cms_menu_items` table
- Indexes and constraints

### Step 2: Seed System Menus (Optional)

Seed the default system menus:

```bash
psql -U your_user -d veylog_db -f database/99b_navigation_seed.sql
```

This creates:
- Main navigation menu
- Footer menu
- Mobile drawer menu
- Footer shop links
- Footer support links

### Step 3: Verify Backend Code

The module code is already in place at:
```
src/modules/navigation/
├── cms-navigation.types.ts
├── cms-navigation.repository.ts
├── cms-navigation.service.ts
├── cms-navigation.controller.ts
├── cms-navigation.schemas.ts
├── cms-navigation.routes.ts
└── README.md
```

The routes are already mounted in `src/app.ts`.

### Step 4: Add Permissions

Ensure admin roles have navigation permissions:

```sql
-- Check if permissions exist
SELECT * FROM permissions WHERE key LIKE 'content.navigation%';

-- If not, they should be in your permissions table as:
-- content.navigation.read
-- content.navigation.create
-- content.navigation.update
-- content.navigation.delete

-- Assign to appropriate roles (example for admin role)
INSERT INTO role_permissions (role_id, permission_id)
SELECT 
  (SELECT id FROM roles WHERE key = 'admin'),
  id
FROM permissions
WHERE key LIKE 'content.navigation%';
```

### Step 5: Test Backend

Start the backend:

```bash
npm run dev
```

Test the API:

```bash
# List menus
curl -X GET http://localhost:3000/admin/api/v1/cms/menus \
  -H "Authorization: Bearer YOUR_TOKEN"

# Create menu
curl -X POST http://localhost:3000/admin/api/v1/cms/menus \
  -H "Authorization: Bearer YOUR_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"name":"Test Menu","is_active":true}'
```

---

## Frontend Installation

### Step 1: Install Dependencies

```bash
cd ../veylog-fronend-admin
npm install @dnd-kit/core @dnd-kit/sortable @dnd-kit/utilities
```

### Step 2: Verify Module Code

The module code is already in place at:
```
src/features/navigation/
├── types.ts
├── api.ts
├── useNavigation.ts
├── utils.ts
├── MenusListPage.tsx
├── MenuItemsManagePage.tsx
├── index.ts
└── README.md
```

### Step 3: Add Routes to Router

Open your main router file (e.g., `src/App.tsx` or routing config) and add:

```typescript
import { MenusListPage, MenuItemsManagePage } from './features/navigation'

// In your Routes configuration:
<Route path="/navigation/menus" element={<MenusListPage />} />
<Route path="/navigation/menus/:menuId/items" element={<MenuItemsManagePage />} />
```

### Step 4: Update Route Registry

Open `src/navigation/routeRegistry.ts` and ensure these keys exist:

```typescript
export const IMPLEMENTED_ROUTE_KEYS = new Set<string>([
  // ... existing routes
  'navigation',
  'navigation.menus',
])
```

### Step 5: Configure Sidebar Navigation (Database)

The navigation menu items are controlled by the database. Ensure you have a menu item for navigation:

```sql
-- Example: Add navigation menu item to admin sidebar
INSERT INTO admin_menu_items (
  parent_id,
  label,
  icon,
  route_key,
  sort_order,
  is_available
) VALUES (
  NULL,
  'Navigation',
  'menu',
  'navigation.menus',
  40,
  true
);
```

### Step 6: Test Frontend

Start the dev server:

```bash
npm run dev
```

Navigate to:
- http://localhost:5173/navigation/menus

You should see the MenusListPage with any existing menus.

---

## Verification Checklist

### Backend ✅
- [ ] Database tables created (`cms_menus`, `cms_menu_items`)
- [ ] Enum type created (`link_type_enum`)
- [ ] System menus seeded (if desired)
- [ ] Permissions added to roles
- [ ] Backend server starts without errors
- [ ] API endpoints respond correctly
- [ ] Authentication works

### Frontend ✅
- [ ] Dependencies installed (@dnd-kit packages)
- [ ] Routes added to router
- [ ] Route registry updated
- [ ] Frontend builds without errors
- [ ] Can navigate to `/navigation/menus`
- [ ] Can see list of menus
- [ ] Can click "Manage Items" button
- [ ] Drag-and-drop works

---

## Quick Test Workflow

### 1. Create a Menu
1. Go to `/navigation/menus`
2. Click "Create Menu"
3. Enter name: "Test Menu"
4. Slug auto-generates: "test-menu"
5. Click "Create"
6. Menu appears in grid

### 2. Add Menu Items
1. Click "Manage Items" on your test menu
2. Click "Add Item"
3. Fill in:
   - Label: "Home"
   - Link Type: "url"
   - URL: "https://example.com"
4. Click "Create"
5. Item appears in tree

### 3. Create Nested Item
1. Click "Add Item" again
2. Fill in:
   - Label: "About"
   - Link Type: "page"
   - Reference ID: 1
   - Parent Item: "Home"
3. Click "Create"
4. Item appears nested under "Home"

### 4. Test Drag-and-Drop
1. Grab the drag handle (≡) on "About"
2. Drag it above "Home"
3. Items reorder
4. Refresh page - order persists

### 5. Test Edit
1. Click edit icon on "Home"
2. Change label to "Homepage"
3. Click "Save Changes"
4. Label updates

### 6. Test Delete
1. Click delete icon on "About"
2. Confirm deletion
3. Item removed from tree

---

## Common Issues & Solutions

### Backend Issues

**Issue**: "relation 'cms_menus' does not exist"
```bash
# Solution: Run the migration
psql -U your_user -d veylog_db -f database/14_navigation.sql
```

**Issue**: "permission denied for table cms_menus"
```bash
# Solution: Grant permissions to your database user
GRANT ALL ON cms_menus TO your_user;
GRANT ALL ON cms_menu_items TO your_user;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO your_user;
```

**Issue**: "401 Unauthorized" on API calls
```bash
# Solution: Check authentication token is valid
# Verify middleware is properly configured
# Check permission assignments in database
```

### Frontend Issues

**Issue**: "Module not found: @dnd-kit/core"
```bash
# Solution: Install dependencies
npm install @dnd-kit/core @dnd-kit/sortable @dnd-kit/utilities
```

**Issue**: "Route not found" when navigating
```typescript
// Solution: Ensure routes are added to your router
// Check path matches exactly: /navigation/menus
```

**Issue**: Drag-and-drop not working
```bash
# Solution: 
# 1. Check @dnd-kit packages installed
# 2. Verify flatItems array is generated
# 3. Check browser console for errors
# 4. Try different browser
```

**Issue**: "Cannot read property 'data' of undefined"
```typescript
// Solution: Add loading state check
if (isLoading) return <CircularProgress />
if (!data) return null
```

---

## Configuration

### Backend Configuration

API prefix is configured in `src/config/env.ts`:
```typescript
apiPrefix: '/admin/api/v1'
```

Routes are mounted at `/cms`:
```typescript
api.use('/cms', cmsNavigationRouter)
```

Full endpoint paths:
```
/admin/api/v1/cms/menus
/admin/api/v1/cms/menu-items
```

### Frontend Configuration

API client base URL in `src/api/client.ts`:
```typescript
const baseURL = import.meta.env.VITE_API_URL || 'http://localhost:3000/admin/api/v1'
```

Ensure your `.env` file has:
```
VITE_API_URL=http://localhost:3000/admin/api/v1
```

---

## Development vs Production

### Development
- Use `npm run dev` for both backend and frontend
- Hot reload enabled
- Detailed error messages
- CORS configured for localhost

### Production
- Build frontend: `npm run build`
- Start backend: `npm start`
- Set environment variables
- Enable production error handling
- Configure CORS for production domains
- Use HTTPS

---

## Next Steps

After successful installation:

1. **Read Documentation**
   - Backend: `src/modules/navigation/README.md`
   - Frontend: `src/features/navigation/README.md`

2. **Customize System Menus**
   - Edit seed data if needed
   - Add your own default menus

3. **Configure Permissions**
   - Assign to appropriate roles
   - Test access control

4. **Integrate with Storefront**
   - Create storefront API endpoints
   - Fetch menu data by slug
   - Render navigation components

5. **Add Monitoring**
   - Log API usage
   - Track errors
   - Monitor performance

---

## Support

If you encounter issues:

1. Check this installation guide
2. Review the README files for detailed docs
3. Check error messages carefully
4. Verify database connections
5. Check browser console for frontend errors
6. Review network tab for API issues

---

## Summary

✅ **Backend**
- Run migration
- Seed menus (optional)
- Add permissions
- Test API

✅ **Frontend**
- Install @dnd-kit
- Add routes
- Update registry
- Test UI

✅ **Verify**
- Create menu
- Add items
- Drag-and-drop
- Edit/delete

You're ready to use the Navigation module! 🎉

---

**Installation Time**: ~15 minutes  
**Difficulty**: Moderate  
**Support**: See documentation in README files
