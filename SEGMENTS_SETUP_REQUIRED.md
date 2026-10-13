# ⚠️ Customer Segments Setup Required

## Current Issue

**Backend API Error:** `GET http://localhost:5173/admin/api/v1/segments 404 (Not Found)`

This means either:
1. ❌ Backend server is not running
2. ❌ Database migration not executed
3. ❌ Routes not properly registered

## Setup Steps

### 1. ✅ Database Migration (REQUIRED)

Execute the database migration file:

```bash
# Option 1: Using MySQL command line
mysql -u root -p veylog_db < database/29_customer_segments.sql

# Option 2: Using MySQL Workbench
# 1. Open MySQL Workbench
# 2. Connect to veylog_db
# 3. File > Open SQL Script > Select database/29_customer_segments.sql
# 4. Execute (Lightning bolt icon or Ctrl+Shift+Enter)
```

**What this creates:**
- `customer_segments` table
- `customer_segment_members` table
- `customer_tags` table
- `customer_tag_assignments` table
- 7 pre-seeded segments (VIP, High-Value, Repeat Buyers, etc.)

### 2. ✅ Start Backend Server

```bash
cd d:\veylog-backend
npm run dev
```

**Expected output:**
```
Server running on port 4000
Database connected
```

### 3. ✅ Verify Backend is Running

Open browser and check:
```
http://localhost:4000/admin/api/v1/health
```

**Expected response:**
```json
{
  "status": "ok",
  "service": "veylog-admin-api",
  "database": "connected",
  ...
}
```

### 4. ✅ Test Segments Endpoint

Using Postman or curl:

```bash
curl -X GET http://localhost:4000/admin/api/v1/segments \
  -H "Authorization: Bearer YOUR_ACCESS_TOKEN"
```

**Expected response:**
```json
{
  "segments": [
    {
      "id": 1,
      "name": "VIP Customers",
      "segment_type": "auto",
      ...
    },
    ...
  ]
}
```

### 5. ✅ Frontend Should Work

Once backend is running:
1. Frontend dev server should already be running on `http://localhost:5173`
2. Navigate to: `http://localhost:5173/customers/segments`
3. You should see the segments list page
4. If you see "No segments found", check that migration was executed

## React Warnings Fixed ✅

The following React warnings have been fixed:

1. ✅ **Radio button props** - Removed FormControlLabel, using plain Radio
2. ✅ **Alpha function error** - Replaced `alpha(tokens.primary, 0.04)` with hardcoded `rgba(33, 150, 243, 0.04)`
3. ✅ **Import cleanup** - Removed unused alpha import

## Backend Code Status ✅

All backend code is complete and ready:
- ✅ Database schema (`29_customer_segments.sql`)
- ✅ Repository (`segments.repository.ts`)
- ✅ Service (`segments.service.ts`)
- ✅ Controller (`segments.controller.ts`)
- ✅ Routes (`segments.routes.ts`)
- ✅ Registered in `app.ts`

## Frontend Code Status ✅

All frontend code is complete and ready:
- ✅ API client (`segments.ts`)
- ✅ List page (`SegmentsPage.tsx`)
- ✅ Detail page (`SegmentDetailPage.tsx`)
- ✅ Form page (`SegmentFormPage.tsx`)
- ✅ Routes registered (`App.tsx`)
- ✅ Route registry updated (`routeRegistry.ts`)

## Quick Start Checklist

- [ ] 1. Run database migration (`29_customer_segments.sql`)
- [ ] 2. Start backend server (`npm run dev` in veylog-backend)
- [ ] 3. Verify backend health endpoint
- [ ] 4. Test segments endpoint with Postman
- [ ] 5. Check frontend page loads
- [ ] 6. Create a test segment
- [ ] 7. Verify it appears in the list

## Troubleshooting

### Backend won't start
- Check if port 4000 is available
- Check database connection in `.env`
- Check MySQL server is running

### 404 errors persist
- Verify `npm run dev` is running
- Check console for TypeScript errors
- Verify routes are registered in `app.ts`

### No segments showing
- Run migration again
- Check database: `SELECT * FROM customer_segments;`
- Check browser console for errors

### Database errors
- Verify MySQL is running
- Check credentials in `.env`
- Ensure database `veylog_db` exists

## Next Steps After Setup

Once everything is running:

1. **Test Create Segment**
   - Click "Create Segment"
   - Fill out form
   - Save and verify it appears

2. **Test Detail View**
   - Click on a segment
   - Verify stats and info display

3. **Test Edit**
   - Click Edit button
   - Modify and save
   - Verify changes

4. **Test Delete**
   - Click Delete button
   - Confirm deletion
   - Verify removed from list

---

**Status:** Backend complete ✅ | Frontend complete ✅ | Migration pending ⏳ | Server pending ⏳
