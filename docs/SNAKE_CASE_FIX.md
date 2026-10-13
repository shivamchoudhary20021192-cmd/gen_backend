# Snake Case Consistency Fix

## Issue
The backend was using mixed naming conventions - schemas expected **camelCase** but the database and frontend used **snake_case**, causing validation failures.

## Root Cause
- Database columns: `page_type`, `body_html`, `hero_media_id`, etc. (snake_case)
- Frontend DTOs: `page_type`, `body_html`, `hero_media_id`, etc. (snake_case)
- Backend schemas: `pageType`, `bodyHtml`, `heroMediaId`, etc. (camelCase) ❌

This mismatch caused validation errors like:
```json
{
  "error": {
    "code": "VALIDATION_FAILED",
    "message": "The request body is invalid.",
    "details": {
      "pageType": ["Required"]
    }
  }
}
```

## Solution
Updated all backend files to use **snake_case** consistently:

### Files Modified

1. **pages.schemas.ts** - Zod validation schemas
   - `pageType` → `page_type`
   - `bodyHtml` → `body_html`
   - `bodyJson` → `body_json`
   - `heroMediaId` → `hero_media_id`
   - `scheduledAt` → `scheduled_at`
   - `unpublishAt` → `unpublish_at`
   - `requiresLegalReview` → `requires_legal_review`
   - `reviewDueAt` → `review_due_at`
   - `isIndexable` → `is_indexable`
   - `showInSitemap` → `show_in_sitemap`
   - `parentId` → `parent_id`
   - And all section-related fields

2. **pages.types.ts** - TypeScript interfaces
   - Updated all interface properties to snake_case
   - `CreatePageDto`, `UpdatePageDto`, `Page`, `PageSection`, etc.

3. **pages.service.ts** - Business logic
   - Updated all property access from camelCase to snake_case
   - `data.pageType` → `data.page_type`
   - `page.requiresLegalReview` → `page.requires_legal_review`
   - And all other references

## Result
✅ Frontend sends: `page_type: "about"`  
✅ Backend validates: `page_type` (snake_case)  
✅ Database stores: `page_type` (snake_case)  
✅ Backend returns: `page_type` (snake_case)  
✅ Frontend receives: `page_type` (snake_case)  

No more validation errors!

## Convention Going Forward
**Always use snake_case for:**
- Database column names
- API request/response fields
- TypeScript interface properties (backend)
- Zod schema fields

This matches PostgreSQL naming conventions and keeps the entire stack consistent.
