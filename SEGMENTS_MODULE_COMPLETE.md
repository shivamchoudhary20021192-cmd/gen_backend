# Customer Segments Module - Complete ✅

## Backend Implementation

### Database Schema (`database/29_customer_segments.sql`)
✅ Tables created:
- `customer_segments` - Segment definitions (manual, auto, imported)
- `customer_segment_members` - Customer-to-segment mappings
- `customer_tags` - Simple labels for customers
- `customer_tag_assignments` - Customer-to-tag mappings

✅ Seeded with 7 example segments:
1. VIP Customers (₹10,000+ spend)
2. High-Value (₹5,000+ spend)
3. Repeat Buyers (3+ orders)
4. First-Time Buyers (1 order)
5. At Risk (no order in 90+ days)
6. Newsletter Subscribers
7. COD Blocked

✅ Menu item status updated to `available`

### API Module (`src/modules/segments/`)
✅ Files created:
- `segments.repository.ts` - Database queries
- `segments.service.ts` - Business logic
- `segments.controller.ts` - HTTP handlers
- `segments.routes.ts` - Route definitions
- `segments.schemas.ts` - Validation schemas

✅ Routes registered in `src/app.ts`:
- `/admin/api/v1/segments/*`

### API Endpoints

#### Segments
- `GET /admin/api/v1/segments` - List all segments (with filters)
- `GET /admin/api/v1/segments/:id` - Get segment details
- `POST /admin/api/v1/segments` - Create new segment
- `PATCH /admin/api/v1/segments/:id` - Update segment
- `DELETE /admin/api/v1/segments/:id` - Soft delete segment

#### Segment Members
- `GET /admin/api/v1/segments/:id/members` - List customers in segment (paginated)
- `POST /admin/api/v1/segments/:id/members` - Add customer to segment
- `DELETE /admin/api/v1/segments/:id/members/:customerId` - Remove customer from segment

#### Tags
- `GET /admin/api/v1/tags` - List all tags
- `POST /admin/api/v1/tags` - Create tag
- `PATCH /admin/api/v1/tags/:id` - Update tag
- `DELETE /admin/api/v1/tags/:id` - Delete tag

#### Customer Tags
- `GET /admin/api/v1/customers/:customerId/tags` - Get customer's tags
- `POST /admin/api/v1/tags/assign` - Assign tag to customer
- `POST /admin/api/v1/tags/remove` - Remove tag from customer

## Features

### Manual Segments
- Admin manually adds/removes customers
- Tracks who added each member
- Full control over membership

### Auto Segments
- Rule-based (JSON conditions)
- Operators: `>=`, `<=`, `=`, `>`, `<`
- Fields: `total_spent`, `orders_count`, `last_order_at`, `accepts_email_marketing`, `cod_blocked`
- AND/OR logic (`rules_operator`)
- Requires background job to recalculate (not yet implemented)

### Tags
- Simple labels for quick filtering
- Usage count tracked
- Color-coded for UI

## Database Migration

Run this command to create the tables:

```bash
# Windows PowerShell (if MySQL is in PATH)
Get-Content database/29_customer_segments.sql | & "C:\Program Files\MySQL\MySQL Server 8.0\bin\mysql.exe" -u root -p veylog_db

# Or manually:
# 1. Open MySQL Workbench
# 2. Connect to veylog_db
# 3. Open database/29_customer_segments.sql
# 4. Execute
```

## Testing

### 1. Start Backend
```bash
npm run dev
```

### 2. Test API with Postman/curl

```bash
# List segments
curl http://localhost:4000/admin/api/v1/segments \
  -H "Authorization: Bearer YOUR_TOKEN"

# Create manual segment
curl -X POST http://localhost:4000/admin/api/v1/segments \
  -H "Authorization: Bearer YOUR_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "name": "Premium Customers",
    "description": "Manually curated premium customer list",
    "segment_type": "manual",
    "color": "#9C27B0",
    "icon": "star"
  }'

# Get segment details
curl http://localhost:4000/admin/api/v1/segments/1 \
  -H "Authorization: Bearer YOUR_TOKEN"

# Add customer to segment
curl -X POST http://localhost:4000/admin/api/v1/segments/1/members \
  -H "Authorization: Bearer YOUR_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"customer_id": 1}'

# List segment members
curl http://localhost:4000/admin/api/v1/segments/1/members?page=1&limit=50 \
  -H "Authorization: Bearer YOUR_TOKEN"
```

## Frontend TODO

Create these pages in `D:\veylog-fronend-admin\src\pages\customers\segments\`:

### 1. Segments List Page (`SegmentsPage.tsx`)
- Table showing all segments
- Columns: Name, Type, Customer Count, Last Calculated, Actions
- Filter by type (manual/auto/imported)
- Search by name
- Click row → go to detail page
- "New Segment" button

### 2. Segment Detail Page (`SegmentDetailPage.tsx`)
- Segment info card (name, description, type, rules)
- Members table with customer details
- For manual segments: "Add Customer" button
- For auto segments: "Recalculate" button (coming soon)
- Edit/Delete buttons

### 3. Segment Form Page (`SegmentFormPage.tsx`)
- Form for create/edit
- Fields: name, description, type, color, icon
- If type=auto: rules builder UI
- Save → navigate back to list

### 4. API Integration (`src/api/segments.ts`)
```typescript
export const segmentsApi = {
  list: (filters?) => apiClient.get('/segments', { params: filters }),
  get: (id) => apiClient.get(`/segments/${id}`),
  create: (data) => apiClient.post('/segments', data),
  update: (id, data) => apiClient.patch(`/segments/${id}`, data),
  delete: (id) => apiClient.delete(`/segments/${id}`),
  getMembers: (id, page, limit) => 
    apiClient.get(`/segments/${id}/members`, { params: { page, limit } }),
  addMember: (id, customerId) => 
    apiClient.post(`/segments/${id}/members`, { customer_id: customerId }),
  removeMember: (id, customerId) => 
    apiClient.delete(`/segments/${id}/members/${customerId}`),
}
```

## Next Steps

1. ✅ Database schema created
2. ✅ Backend API complete
3. ✅ Routes registered
4. ⏳ Run database migration
5. ⏳ Test backend with Postman
6. ⏳ Create frontend pages
7. ⏳ Create auto-segment calculation cron job (future)

## Status

**Backend: COMPLETE ✅**
**Frontend: NOT STARTED ⏳**
**Menu: ENABLED ✅** (status changed to 'available' in DB)

The `/customers/segments` route is now active in the sidebar!
