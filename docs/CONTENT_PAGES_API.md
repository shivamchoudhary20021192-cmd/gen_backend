# Content Pages API - Endpoint Documentation

## Base URL
```
/admin/api/v1/content/pages
```

## Authentication
All endpoints require:
- Bearer token in `Authorization` header
- Appropriate permissions (`content.pages.*`)

---

## Endpoints

### 1. List Pages
**GET** `/admin/api/v1/content/pages`

**Permission**: `content.pages.view`

**Query Parameters**:
```typescript
{
  page?: number              // Default: 1
  limit?: number             // Default: 20, Max: 100
  sortBy?: 'title' | 'status' | 'updated_at' | 'created_at'
  sortOrder?: 'asc' | 'desc'
  search?: string            // Search in title, slug, path
  status?: PageStatus | PageStatus[]
  pageType?: PageType | PageType[]
  authorId?: number
  requiresLegalReview?: boolean
  isIndexable?: boolean
  createdAfter?: string      // ISO datetime
  createdBefore?: string
  publishedAfter?: string
  publishedBefore?: string
}
```

**Response**: 200 OK
```typescript
{
  data: PageListItem[],
  pagination: {
    page: number,
    limit: number,
    total: number,
    totalPages: number,
    hasNext: boolean,
    hasPrev: boolean
  }
}
```

---

### 2. Get Page by ID
**GET** `/admin/api/v1/content/pages/:id`

**Permission**: `content.pages.view`

**Response**: 200 OK
```typescript
PageWithRelations {
  id, publicId, slug, title, status,
  sections: PageSection[],
  author: { id, name, email },
  ...
}
```

---

### 3. Get Page by Slug
**GET** `/admin/api/v1/content/pages/slug/:slug`

**Permission**: `content.pages.view`

**Query Parameters**:
- `locale?: string` (default: 'en-IN')

**Response**: 200 OK

---

### 4. Create Page
**POST** `/admin/api/v1/content/pages`

**Permission**: `content.pages.create`

**Request Body**:
```typescript
{
  slug?: string,              // Auto-generated from title if not provided
  title: string,              // Required
  subtitle?: string,
  pageType: PageType,         // Required
  template?: string,          // Default: 'default'
  locale?: string,            // Default: 'en-IN'
  bodyHtml?: string,
  bodyJson?: any,
  heroMediaId?: number,
  status?: PageStatus,        // Default: 'draft'
  scheduledAt?: string,       // ISO datetime
  unpublishAt?: string,
  requiresLegalReview?: boolean,
  reviewDueAt?: string,
  isIndexable?: boolean,      // Default: true
  showInSitemap?: boolean,    // Default: true
  parentId?: number
}
```

**Response**: 201 Created

---

### 5. Update Page
**PUT** `/admin/api/v1/content/pages/:id`

**Permission**: `content.pages.edit`

**Request Body**: Same as Create (all fields optional)

**Response**: 200 OK

---

### 6. Delete Page
**DELETE** `/admin/api/v1/content/pages/:id`

**Permission**: `content.pages.delete`

**Response**: 204 No Content

**Note**: Cannot delete published pages (must archive first)

---

### 7. Publish Page
**POST** `/admin/api/v1/content/pages/:id/publish`

**Permission**: `content.pages.publish`

**Request Body**:
```typescript
{
  scheduledAt?: string,      // If provided, status becomes 'scheduled'
  unpublishAt?: string
}
```

**Response**: 200 OK

---

### 8. Unpublish Page
**POST** `/admin/api/v1/content/pages/:id/unpublish`

**Permission**: `content.pages.publish`

**Response**: 200 OK (status changes to 'draft')

---

### 9. Archive Page
**POST** `/admin/api/v1/content/pages/:id/archive`

**Permission**: `content.pages.edit`

**Response**: 200 OK

---

### 10. Restore Archived Page
**POST** `/admin/api/v1/content/pages/:id/restore`

**Permission**: `content.pages.edit`

**Response**: 200 OK

---

### 11. Duplicate Page
**POST** `/admin/api/v1/content/pages/:id/duplicate`

**Permission**: `content.pages.create`

**Response**: 201 Created

---

### 12. Mark as Reviewed
**POST** `/admin/api/v1/content/pages/:id/review`

**Permission**: `content.pages.edit`

**Response**: 200 OK

---

### 13. Add Section to Page
**POST** `/admin/api/v1/content/pages/:id/sections`

**Permission**: `content.pages.edit`

**Request Body**:
```typescript
{
  sectionKey: string,         // Required (e.g., 'hero', 'faq')
  name?: string,
  sortOrder?: number,         // Default: 0
  isEnabled?: boolean,        // Default: true
  settings?: any,
  background?: string,
  paddingTop?: 'none'|'sm'|'md'|'lg'|'xl',
  paddingBottom?: 'none'|'sm'|'md'|'lg'|'xl',
  visibleFrom?: string,
  visibleUntil?: string
}
```

**Response**: 201 Created
```typescript
{
  sectionId: number,
  page: PageWithRelations
}
```

---

### 14. Update Section
**PUT** `/admin/api/v1/content/pages/:id/sections/:sectionId`

**Permission**: `content.pages.edit`

**Request Body**: Same as Add Section (all optional)

**Response**: 200 OK

---

### 15. Delete Section
**DELETE** `/admin/api/v1/content/pages/:id/sections/:sectionId`

**Permission**: `content.pages.edit`

**Response**: 204 No Content

---

### 16. Reorder Sections
**PUT** `/admin/api/v1/content/pages/:id/sections/reorder`

**Permission**: `content.pages.edit`

**Request Body**:
```typescript
{
  sections: [
    { id: number, sortOrder: number },
    ...
  ]
}
```

**Response**: 200 OK

---

### 17. Bulk Update Pages
**POST** `/admin/api/v1/content/pages/bulk-update`

**Permission**: `content.pages.edit`

**Request Body**:
```typescript
{
  ids: number[],             // Required, min 1
  status: PageStatus         // Required
}
```

**Response**: 200 OK
```typescript
{
  success: true,
  updatedCount: number,
  totalCount: number
}
```

---

## Page Types
```typescript
'home' | 'standard' | 'landing' | 'policy' | 'about' | 
'support' | 'concern' | 'ingredient_library' | 'custom'
```

## Page Status
```typescript
'draft' | 'in_review' | 'scheduled' | 'published' | 'archived'
```

## Status Transitions
```typescript
draft       → in_review, published, archived
in_review   → draft, published, archived
scheduled   → draft, published, archived
published   → draft, archived
archived    → draft
```

## Section Types
```typescript
'announcement_bar', 'hero', 'trust_strip', 'two_product_routine',
'ingredient_story', 'texture_proof', 'evidence_results', 'reviews_ugc',
'education_articles', 'founder_note', 'optin', 'faq', 'rich_text',
'image_with_text', 'product_grid', 'collection_banner', 'comparison_table',
'support_panel'
```

---

## Error Codes

| Code | Status | Description |
|------|--------|-------------|
| NOT_FOUND | 404 | Page not found |
| SLUG_TAKEN | 400 | Slug already exists |
| BAD_REQUEST | 400 | Invalid request data |
| INVALID_TRANSITION | 400 | Invalid status transition or operation not allowed |
| UNAUTHENTICATED | 401 | Missing or invalid token |
| FORBIDDEN | 403 | Insufficient permissions |
| VALIDATION_FAILED | 422 | Validation errors in request body |

---

## Testing with cURL

### Create a page:
```bash
curl -X POST http://localhost:4000/admin/api/v1/content/pages \
  -H "Authorization: Bearer YOUR_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "title": "About Us",
    "pageType": "about",
    "bodyHtml": "<p>Welcome to our company</p>",
    "status": "draft"
  }'
```

### List pages:
```bash
curl -X GET "http://localhost:4000/admin/api/v1/content/pages?page=1&limit=10" \
  -H "Authorization: Bearer YOUR_TOKEN"
```

### Publish a page:
```bash
curl -X POST http://localhost:4000/admin/api/v1/content/pages/1/publish \
  -H "Authorization: Bearer YOUR_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{}'
```

---

## Notes

1. **Slug Generation**: If no slug provided, it's auto-generated from title using slugify
2. **Legal Review**: Pages marked with `requiresLegalReview=true` cannot be published without review
3. **Soft Delete**: Deleted pages are not removed from database (deleted_at is set)
4. **Sections**: Pages can have multiple sections for modular content (Shopify-style)
5. **Versioning**: All changes increment `currentVersion` (revision system ready)

---

Last Updated: 2026-09-10
Status: ✅ Ready for Testing
