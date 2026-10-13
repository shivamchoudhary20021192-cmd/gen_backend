# 🎨 Advanced Sidebar System - Implementation Guide

## 🎯 Overview

Industry-standard sidebar with **collapsible/expandable modes**, **user preferences**, **pin functionality**, and **smooth animations**.

---

## 📋 Features Implemented

### ✅ Backend (Complete)

1. **Enhanced Database Schema**
   - `menu_items` table: 15+ new columns for advanced control
   - `user_sidebar_preferences` table: User customization storage
   - `menu_item_analytics` table: Click tracking
   - `sidebar_sections` table: Section/group management

2. **Smart Filtering**
   - `is_visible` column: Global show/hide control (0 = hidden from API response)
   - `show_in_collapsed`: Show in mini/icon-only mode
   - `requires_super_admin`: Role-based filtering
   - `is_active`: Enable/disable items

3. **User Preferences**
   - Collapsed/expanded state
   - Pinned/unpinned mode
   - Custom width
   - Pinned items array
   - Hidden items array
   - Recent items (last 10)
   - Favorite items
   - Animation speed preference

4. **API Endpoints**
   ```
   GET    /admin/api/v1/sidebar/menu              - Full menu tree
   GET    /admin/api/v1/sidebar/menu/collapsed    - Mini menu only
   GET    /admin/api/v1/sidebar/preferences       - User prefs
   PATCH  /admin/api/v1/sidebar/preferences       - Update prefs
   POST   /admin/api/v1/sidebar/toggle-pin        - Toggle pin
   POST   /admin/api/v1/sidebar/toggle-collapse   - Toggle collapse
   POST   /admin/api/v1/sidebar/pin-item          - Pin item
   POST   /admin/api/v1/sidebar/unpin-item        - Unpin item
   POST   /admin/api/v1/sidebar/favorite          - Add favorite
   DELETE /admin/api/v1/sidebar/favorite/:id      - Remove favorite
   POST   /admin/api/v1/sidebar/track-click       - Track analytics
   GET    /admin/api/v1/sidebar/analytics         - Get stats
   ```

---

## 🗄️ Database Schema

### New Columns in `menu_items`

| Column | Type | Description |
|--------|------|-------------|
| `is_visible` | TINYINT | **0 = Hidden from API**, 1 = Visible |
| `show_in_collapsed` | TINYINT | Show in mini/icon mode |
| `is_pinnable` | TINYINT | Can user pin this item |
| `icon_color` | VARCHAR | Icon color (hex) |
| `hover_description` | VARCHAR | Tooltip text |
| `keyboard_shortcut` | VARCHAR | e.g., "Ctrl+Shift+P" |
| `divider_after` | TINYINT | Show divider after item |
| `group_key` | VARCHAR | Collapsible group |
| `analytics_key` | VARCHAR | Track clicks |
| `metadata` | JSON | Flexible extra data |

### New Table: `user_sidebar_preferences`

```sql
- is_collapsed (mini mode)
- is_pinned (stay open vs auto-hide)
- width / collapsed_width
- pinned_items (JSON array)
- hidden_items (JSON array)
- recent_items (JSON array)
- favorite_items (JSON array)
- animation_speed
```

---

## 🚀 Quick Start

### Step 1: Run Migration

```bash
cd d:\veylog-backend
mysql -u root -p veylog_db < database/28_advanced_sidebar.sql
```

### Step 2: Verify

```bash
# Check new columns
mysql -u root -p veylog_db -e "DESCRIBE menu_items"

# Check new tables
mysql -u root -p veylog_db -e "SHOW TABLES LIKE '%sidebar%'"

# Check sections
mysql -u root -p veylog_db -e "SELECT * FROM sidebar_sections"
```

### Step 3: Restart Backend

```bash
cd d:\veylog-backend
npm run dev
```

### Step 4: Test API

```bash
# Get menu (requires auth token)
curl -H "Authorization: Bearer YOUR_TOKEN" \
  http://localhost:3000/admin/api/v1/sidebar/menu

# Get preferences
curl -H "Authorization: Bearer YOUR_TOKEN" \
  http://localhost:3000/admin/api/v1/sidebar/preferences
```

---

## 🎨 Frontend Implementation

### React Hook Example

```typescript
// hooks/useSidebar.ts
import { useQuery, useMutation } from '@tanstack/react-query';
import { api } from '../api/client';

interface SidebarMenu {
  menu: MenuItem[];
  sections: Section[];
  preferences: UserPreferences;
}

export function useSidebar() {
  return useQuery({
    queryKey: ['sidebar', 'menu'],
    queryFn: async () => {
      const response = await api.get<SidebarMenu>('/sidebar/menu');
      return response;
    },
    staleTime: 5 * 60 * 1000, // 5 minutes
  });
}

export function useToggleSidebarPin() {
  return useMutation({
    mutationFn: async () => {
      return api.post('/sidebar/toggle-pin');
    },
  });
}

export function useToggleSidebarCollapse() {
  return useMutation({
    mutationFn: async () => {
      return api.post('/sidebar/toggle-collapse');
    },
  });
}

export function useTrackMenuClick() {
  return useMutation({
    mutationFn: async (data: { menu_item_id: number; session_id: string }) => {
      return api.post('/sidebar/track-click', data);
    },
  });
}
```

### Sidebar Component (Material-UI)

```typescript
// components/Sidebar.tsx
import { Drawer, List, ListItem, IconButton, Tooltip } from '@mui/material';
import { PushPin, Close } from '@mui/icons-material';
import { useSidebar, useToggleSidebarPin } from '../hooks/useSidebar';

export function Sidebar() {
  const { data, isLoading } = useSidebar();
  const togglePin = useToggleSidebarPin();

  if (isLoading) return <div>Loading...</div>;

  const { menu, preferences } = data!;
  const isCollapsed = preferences.is_collapsed;
  const isPinned = preferences.is_pinned;
  const width = isCollapsed ? preferences.collapsed_width : preferences.width;

  return (
    <Drawer
      variant={isPinned ? 'permanent' : 'temporary'}
      sx={{
        width,
        '& .MuiDrawer-paper': {
          width,
          transition: 'width 0.3s ease',
        },
      }}
    >
      {/* Header */}
      <div style={{ display: 'flex', justifyContent: 'space-between', padding: 16 }}>
        <h2>{isCollapsed ? 'V' : 'Veylog'}</h2>
        <IconButton onClick={() => togglePin.mutate()}>
          <PushPin color={isPinned ? 'primary' : 'default'} />
        </IconButton>
      </div>

      {/* Menu Items */}
      <List>
        {menu.map(item => (
          <Tooltip 
            key={item.id} 
            title={isCollapsed ? item.title : ''}
            placement="right"
          >
            <ListItem button>
              {/* Render icon and title */}
            </ListItem>
          </Tooltip>
        ))}
      </List>
    </Drawer>
  );
}
```

---

## 🎭 Animation Best Practices

### CSS Transitions

```css
/* Smooth width transition */
.sidebar {
  width: var(--sidebar-width);
  transition: width 300ms cubic-bezier(0.4, 0, 0.2, 1);
}

.sidebar.collapsed {
  width: var(--sidebar-collapsed-width);
}

/* Icon rotation on expand */
.sidebar-icon {
  transition: transform 200ms ease;
}

.sidebar-icon.expanded {
  transform: rotate(90deg);
}

/* Fade in/out for text */
.sidebar-text {
  opacity: 1;
  transition: opacity 200ms ease;
}

.sidebar.collapsed .sidebar-text {
  opacity: 0;
  width: 0;
  overflow: hidden;
}
```

### Framer Motion (React)

```typescript
import { motion, AnimatePresence } from 'framer-motion';

<motion.div
  initial={{ width: 64 }}
  animate={{ width: isCollapsed ? 64 : 280 }}
  transition={{ duration: 0.3, ease: 'easeInOut' }}
>
  {/* Sidebar content */}
</motion.div>
```

---

## 🔧 Configuration

### Hide Menu Item from All Users

```sql
UPDATE menu_items 
SET is_visible = 0 
WHERE menu_key = 'some_feature';
```

Now it **won't appear in API response** at all!

### Show Only in Full Mode (Not Mini)

```sql
UPDATE menu_items 
SET show_in_collapsed = 0 
WHERE menu_key = 'detailed_feature';
```

### Coming Soon Status

```sql
UPDATE menu_items 
SET status = 'coming_soon' 
WHERE menu_key = 'future_feature';
```

Frontend can show a badge: "Coming Soon"

---

## 📊 Analytics

### Track Most Used Features

```sql
SELECT 
  mi.title,
  COUNT(*) as clicks,
  COUNT(DISTINCT mia.user_id) as unique_users
FROM menu_item_analytics mia
JOIN menu_items mi ON mia.menu_item_id = mi.id
WHERE mia.clicked_at >= DATE_SUB(NOW(), INTERVAL 30 DAY)
GROUP BY mi.id
ORDER BY clicks DESC
LIMIT 10;
```

### User's Recent Items

```sql
SELECT recent_items 
FROM user_sidebar_preferences 
WHERE user_id = 123;
```

---

## 🎯 LocalStorage Integration (Frontend)

```typescript
// Persist sidebar state client-side for instant UX
const SIDEBAR_KEY = 'veylog.sidebar_state';

// Save to localStorage
function saveSidebarState(state: {
  isCollapsed: boolean;
  isPinned: boolean;
  width: number;
}) {
  localStorage.setItem(SIDEBAR_KEY, JSON.stringify(state));
}

// Load from localStorage (instant on page load)
function loadSidebarState() {
  const stored = localStorage.getItem(SIDEBAR_KEY);
  return stored ? JSON.parse(stored) : null;
}

// Sync with API (background)
function syncWithAPI(state) {
  api.patch('/sidebar/preferences', state);
}

// Usage in component
useEffect(() => {
  // Load instantly from localStorage
  const cached = loadSidebarState();
  if (cached) {
    setSidebarState(cached);
  }

  // Fetch fresh from API (background)
  fetchSidebarPreferences().then(fresh => {
    setSidebarState(fresh);
    saveSidebarState(fresh); // Update cache
  });
}, []);
```

---

## 🎨 UI/UX Best Practices

### 1. **Hover to Expand (Mini Mode)**

When collapsed, hovering should temporarily expand:

```typescript
const [isHovering, setIsHovering] = useState(false);

<div
  onMouseEnter={() => setIsHovering(true)}
  onMouseLeave={() => setIsHovering(false)}
  style={{
    width: isCollapsed && !isHovering ? 64 : 280,
  }}
>
```

### 2. **Pin Button Visibility**

Show pin button on hover:

```css
.sidebar-header .pin-button {
  opacity: 0;
  transition: opacity 200ms;
}

.sidebar-header:hover .pin-button {
  opacity: 1;
}
```

### 3. **Tooltips (Mini Mode)**

Always show tooltips when collapsed:

```typescript
<Tooltip 
  title={item.hover_description || item.title}
  placement="right"
  disableHoverListener={!isCollapsed}
>
```

### 4. **Smooth Icon Transitions**

```typescript
<motion.div
  animate={{ rotate: isExpanded ? 90 : 0 }}
  transition={{ duration: 0.2 }}
>
  <ChevronRight />
</motion.div>
```

### 5. **Keyboard Shortcuts**

```typescript
useEffect(() => {
  const handleKeyPress = (e: KeyboardEvent) => {
    if (e.ctrlKey && e.shiftKey && e.key === 'B') {
      toggleSidebar();
    }
  };

  window.addEventListener('keydown', handleKeyPress);
  return () => window.removeEventListener('keydown', handleKeyPress);
}, []);
```

---

## 📱 Responsive Behavior

```typescript
// Auto-collapse on mobile
useEffect(() => {
  const handleResize = () => {
    if (window.innerWidth < 768) {
      setIsCollapsed(true);
      setIsPinned(false); // Overlay on mobile
    }
  };

  window.addEventListener('resize', handleResize);
  handleResize(); // Initial check

  return () => window.removeEventListener('resize', handleResize);
}, []);
```

---

## 🧪 Testing Checklist

- [ ] Menu loads from API
- [ ] Collapsed/expanded transition smooth
- [ ] Pin button toggles state
- [ ] LocalStorage persists state across reload
- [ ] Tooltips show in mini mode
- [ ] Pinned items appear at top
- [ ] Recent items update after navigation
- [ ] Analytics track clicks
- [ ] Keyboard shortcuts work
- [ ] Mobile responsive (overlay mode)
- [ ] Role permissions filter correctly
- [ ] Coming soon items show badge
- [ ] Hidden items don't appear

---

## 🚀 Deployment Steps

### 1. Run Migration

```bash
mysql -u root -p veylog_db < database/28_advanced_sidebar.sql
```

### 2. Deploy Backend

```bash
npm run build
pm2 restart veylog-backend
```

### 3. Update Frontend

```bash
# Install sidebar hook and components
npm run build
pm2 restart veylog-frontend-admin
```

### 4. Clear User Cache

Users may need to refresh to see new sidebar. Send notification:
"🎉 New sidebar released! Press Ctrl+Shift+R to see the updates."

---

## 📚 API Response Examples

### GET /sidebar/menu

```json
{
  "menu": [
    {
      "id": 1,
      "menu_key": "dashboard",
      "title": "Dashboard",
      "icon": "dashboard",
      "icon_color": "#3b82f6",
      "route": "/dashboard",
      "is_pinned_by_user": true,
      "show_in_collapsed": true,
      "children": []
    }
  ],
  "sections": [
    {
      "key": "commerce",
      "title": "Commerce",
      "color": "#10b981",
      "is_collapsible": true
    }
  ],
  "preferences": {
    "is_collapsed": false,
    "is_pinned": true,
    "width": 280,
    "pinned_items": [1, 8, 16],
    "animation_speed": "normal"
  }
}
```

---

## 🎉 Result

You now have an **industry-standard sidebar** with:

✅ **Mini/Full modes** - Icon-only or full sidebar  
✅ **Pin/Unpin** - Stay open or auto-hide  
✅ **User preferences** - Persisted in database + localStorage  
✅ **Smart filtering** - `is_visible` controls API response  
✅ **Analytics** - Track most-used features  
✅ **Smooth animations** - Professional transitions  
✅ **Keyboard shortcuts** - Power user features  
✅ **Responsive** - Mobile-ready  
✅ **Hierarchical** - Nested menus with sections  
✅ **Role-based** - Permission filtering  

**Best-in-class sidebar system ready for production! 🚀**
