# FAQs Module Documentation

## Overview

The FAQs module provides a comprehensive system for managing frequently asked questions with grouping, rich text editing, entity associations, and publishing workflows. It follows the same architectural patterns as the Banners module with full TypeScript support, validation, and permissions.

## Features

### FAQ Groups
- Organize FAQs into logical groups
- Slug-based URLs for SEO-friendly access
- Sort order management
- Active/inactive status
- Automatic FAQ count tracking

### FAQs
- Rich text editor for detailed answers (Tiptap)
- Question length validation (max 500 characters)
- Entity associations (products, pages, collections, categories, articles)
- Publish/unpublish workflow
- Search indexability control
- Helpful count tracking
- Claim ID support for legal/compliance tracking
- Sort order for custom positioning

## Architecture

### Backend Structure

```
src/modules/content/faqs/
├── faqs.types.ts          # TypeScript interfaces and types
├── faqs.repository.ts     # Database queries (SQL)
├── faqs.service.ts        # Business logic and validation
├── faqs.controller.ts     # HTTP request handlers
├── faqs.schemas.ts        # Zod validation schemas
├── faqs.routes.ts         # Express route definitions
└── README.md              # This file
```

### Frontend Structure

```
src/features/content/faqs/
├── types.ts               # Frontend TypeScript types
├── api.ts                 # API client functions
├── useFAQs.ts            # React Query hooks
├── utils.ts              # Utility functions
├── FAQsListPage.tsx      # List view with filters and table
├── FAQFormPage.tsx       # Create/edit form with rich text editor
└── index.ts              # Module exports
```

## Database Schema

### cms_faq_groups Table

| Column | Type | Description |
|--------|------|-------------|
| id | INT | Primary key |
| slug | VARCHAR(140) | Unique URL-friendly identifier |
| name | VARCHAR(160) | Display name |
| description | VARCHAR(500) | Optional description |
| sort_order | SMALLINT UNSIGNED | Display order (0-65535) |
| is_active | BOOLEAN | Active status |
| created_at | TIMESTAMP | Creation timestamp |
| updated_at | TIMESTAMP | Last update timestamp |

**Indexes:**
- PRIMARY KEY (id)
- UNIQUE KEY (slug)
- INDEX (is_active, sort_order)

### cms_faqs Table

| Column | Type | Description |
|--------|------|-------------|
| id | INT | Primary key |
| group_id | INT | Foreign key to cms_faq_groups (nullable) |
| entity_type | ENUM | Type of associated entity (nullable) |
| entity_id | INT | ID of associated entity (nullable) |
| question | VARCHAR(500) | The question text |
| answer | TEXT | Rich text answer (HTML) |
| claim_id | INT | Optional claim reference |
| sort_order | SMALLINT UNSIGNED | Display order (0-65535) |
| is_published | BOOLEAN | Published status |
| is_indexable | BOOLEAN | Search engine indexability |
| helpful_count | INT | Number of helpful votes |
| published_at | TIMESTAMP | Publication timestamp (nullable) |
| created_at | TIMESTAMP | Creation timestamp |
| updated_at | TIMESTAMP | Last update timestamp |

**Entity Types:**
- `product` - Product-specific FAQ
- `cms_page` - CMS page FAQ
- `collection` - Collection FAQ
- `category` - Category FAQ
- `article` - Article/blog FAQ

**Indexes:**
- PRIMARY KEY (id)
- INDEX (group_id)
- INDEX (entity_type, entity_id)
- INDEX (is_published, sort_order)
- INDEX (is_indexable)

**Foreign Keys:**
- group_id REFERENCES cms_faq_groups(id) ON DELETE SET NULL

## API Endpoints

### FAQ Groups

#### List FAQ Groups
```http
GET /admin/api/v1/content/faq-groups
```

**Query Parameters:**
- `page` (number) - Page number (default: 1)
- `limit` (number) - Items per page (default: 20, max: 100)
- `sort_by` (string) - Sort field: `name`, `sort_order`, `created_at`
- `sort_order` (string) - Sort direction: `asc`, `desc`
- `search` (string) - Search by name or description
- `is_active` (boolean) - Filter by active status

**Response:**
```json
{
  "data": [
    {
      "id": 1,
      "slug": "shipping-returns",
      "name": "Shipping & Returns",
      "description": "Questions about shipping and returns",
      "sort_order": 10,
      "is_active": true,
      "faq_count": 5,
      "created_at": "2024-01-15T10:00:00Z",
      "updated_at": "2024-01-20T14:30:00Z"
    }
  ],
  "pagination": {
    "page": 1,
    "limit": 20,
    "total": 50,
    "totalPages": 3,
    "hasNext": true,
    "hasPrev": false
  }
}
```

#### Get FAQ Group by ID
```http
GET /admin/api/v1/content/faq-groups/:id
```

#### Get FAQ Group by Slug
```http
GET /admin/api/v1/content/faq-groups/slug/:slug
```

#### Create FAQ Group
```http
POST /admin/api/v1/content/faq-groups
```

**Request Body:**
```json
{
  "slug": "shipping-returns",
  "name": "Shipping & Returns",
  "description": "Questions about shipping and returns",
  "sort_order": 10,
  "is_active": true
}
```

**Validation Rules:**
- `slug` - Optional; auto-generated from name if not provided; must be kebab-case (lowercase, numbers, hyphens); max 140 chars
- `name` - Required; max 160 characters
- `description` - Optional; max 500 characters
- `sort_order` - Optional; 0-65535 (default: 0)
- `is_active` - Optional; boolean (default: true)

#### Update FAQ Group
```http
PUT /admin/api/v1/content/faq-groups/:id
```

#### Delete FAQ Group
```http
DELETE /admin/api/v1/content/faq-groups/:id
```

**Note:** Cannot delete if group has associated FAQs. FAQs must be reassigned or deleted first.

---

### FAQs

#### List FAQs
```http
GET /admin/api/v1/content/faqs
```

**Query Parameters:**
- `page` (number) - Page number
- `limit` (number) - Items per page (max: 100)
- `sort_by` (string) - `question`, `group_id`, `sort_order`, `helpful_count`, `created_at`, `updated_at`
- `sort_order` (string) - `asc`, `desc`
- `search` (string) - Search in question and answer
- `group_id` (number) - Filter by group
- `entity_type` (string) - Filter by entity type
- `entity_id` (number) - Filter by entity ID
- `is_published` (boolean) - Filter by published status
- `is_indexable` (boolean) - Filter by indexable status

**Response:**
```json
{
  "data": [
    {
      "id": 1,
      "group_id": 1,
      "group_name": "Shipping & Returns",
      "group_slug": "shipping-returns",
      "entity_type": "product",
      "entity_id": 42,
      "question": "What is your return policy?",
      "answer": "<p>We accept returns within 30 days...</p>",
      "claim_id": null,
      "sort_order": 10,
      "is_published": true,
      "is_indexable": true,
      "helpful_count": 25,
      "published_at": "2024-01-15T10:00:00Z",
      "created_at": "2024-01-15T10:00:00Z",
      "updated_at": "2024-01-20T14:30:00Z"
    }
  ],
  "pagination": { /* ... */ }
}
```

#### Get FAQ by ID
```http
GET /admin/api/v1/content/faqs/:id
```

**Response:**
```json
{
  "id": 1,
  "group_id": 1,
  "entity_type": "product",
  "entity_id": 42,
  "question": "What is your return policy?",
  "answer": "<p>We accept returns within 30 days...</p>",
  "claim_id": null,
  "sort_order": 10,
  "is_published": true,
  "is_indexable": true,
  "helpful_count": 25,
  "published_at": "2024-01-15T10:00:00Z",
  "created_at": "2024-01-15T10:00:00Z",
  "updated_at": "2024-01-20T14:30:00Z",
  "group": {
    "id": 1,
    "slug": "shipping-returns",
    "name": "Shipping & Returns"
  }
}
```

#### Create FAQ
```http
POST /admin/api/v1/content/faqs
```

**Request Body:**
```json
{
  "group_id": 1,
  "entity_type": "product",
  "entity_id": 42,
  "question": "What is your return policy?",
  "answer": "<p>We accept returns within 30 days of purchase.</p>",
  "claim_id": null,
  "sort_order": 10,
  "is_published": true,
  "is_indexable": true
}
```

**Validation Rules:**
- `question` - Required; max 500 characters
- `answer` - Required; TEXT field (rich HTML)
- `group_id` - Optional; must exist if provided
- `entity_type` - Optional; enum: `product`, `cms_page`, `collection`, `category`, `article`
- `entity_id` - Optional; required if entity_type is provided
- `claim_id` - Optional; positive integer
- `sort_order` - Optional; 0-65535 (default: 0)
- `is_published` - Optional; boolean (default: false)
- `is_indexable` - Optional; boolean (default: true)

#### Update FAQ
```http
PUT /admin/api/v1/content/faqs/:id
```

#### Delete FAQ
```http
DELETE /admin/api/v1/content/faqs/:id
```

#### Mark FAQ as Helpful
```http
POST /admin/api/v1/content/faqs/:id/helpful
```

Increments the `helpful_count` by 1.

#### Publish FAQ
```http
POST /admin/api/v1/content/faqs/:id/publish
```

Sets `is_published = true` and updates `published_at` timestamp.

#### Unpublish FAQ
```http
POST /admin/api/v1/content/faqs/:id/unpublish
```

Sets `is_published = false` and clears `published_at` timestamp.

#### Bulk Update Sort Order
```http
POST /admin/api/v1/content/faqs/bulk-sort
```

**Request Body:**
```json
{
  "updates": [
    { "id": 1, "sort_order": 0 },
    { "id": 2, "sort_order": 10 },
    { "id": 3, "sort_order": 20 }
  ]
}
```

Updates multiple FAQ sort orders in a single transaction.

## Permissions

All routes require authentication and the following permissions:

- `content.faqs.read` - View FAQ groups and FAQs
- `content.faqs.create` - Create new FAQ groups and FAQs
- `content.faqs.update` - Update existing FAQ groups and FAQs (includes publish/unpublish/helpful)
- `content.faqs.delete` - Delete FAQ groups and FAQs

## Frontend Usage

### Hooks

```typescript
import {
  useFAQs,
  useFAQ,
  useCreateFAQ,
  useUpdateFAQ,
  useDeleteFAQ,
  usePublishFAQ,
  useUnpublishFAQ,
  useMarkFAQHelpful,
  useFAQGroups,
  useFAQGroup,
  useCreateFAQGroup,
  useUpdateFAQGroup,
  useDeleteFAQGroup,
} from '@/features/content/faqs'

// List FAQs with filters
const { data, isLoading } = useFAQs({
  page: 1,
  limit: 20,
  search: 'shipping',
  group_id: 1,
  is_published: true,
})

// Get single FAQ
const { data: faq } = useFAQ(1)

// Create FAQ
const createMutation = useCreateFAQ()
await createMutation.mutateAsync({
  question: 'How long does shipping take?',
  answer: '<p>Shipping typically takes 3-5 business days.</p>',
  group_id: 1,
  is_published: true,
})

// Update FAQ
const updateMutation = useUpdateFAQ()
await updateMutation.mutateAsync({
  id: 1,
  data: { question: 'Updated question' },
})

// Publish/Unpublish
const publishMutation = usePublishFAQ()
await publishMutation.mutateAsync(1)

const unpublishMutation = useUnpublishFAQ()
await unpublishMutation.mutateAsync(1)
```

### Utility Functions

```typescript
import {
  getEntityTypeLabel,
  formatEntityReference,
  validateQuestion,
  validateAnswer,
  validateEntityRelation,
  generateSlug,
  getAnswerPreview,
  stripHtmlTags,
} from '@/features/content/faqs'

// Entity type labels
const label = getEntityTypeLabel('product') // "Product"
const ref = formatEntityReference('product', 42) // "Product #42"

// Validation
const questionError = validateQuestion('') // "Question is required"
const answerError = validateAnswer('<p>Valid answer</p>') // null
const entityError = validateEntityRelation('product', null) // "Entity ID is required..."

// Slug generation
const slug = generateSlug('Shipping & Returns') // "shipping-returns"

// Text helpers
const preview = getAnswerPreview('<p>Long HTML answer...</p>', 100)
const plain = stripHtmlTags('<p>HTML text</p>') // "HTML text"
```

## Rich Text Editor

The FAQ answer field uses the Tiptap rich text editor with the following features:

- **Text Formatting:** Bold, Italic, Underline, Strikethrough
- **Headings:** H1-H6 and Paragraph
- **Lists:** Bullet and Numbered
- **Alignment:** Left, Center, Right
- **Links:** Add/edit/remove hyperlinks
- **Blockquotes:** For emphasis
- **Code Blocks:** For technical content
- **Undo/Redo:** Full history support

### Editor Usage

```tsx
import { RichTextEditor } from '@/features/content/pages/RichTextEditor'

<RichTextEditor
  content={answer}
  onChange={setAnswer}
  placeholder="Write a detailed answer..."
  error={!!errors.answer}
  helperText={errors.answer}
/>
```

## Validation

### Backend Validation (Zod)

All API endpoints validate input using Zod schemas:

```typescript
// Question validation
createFAQSchema.shape.question
  .min(1)
  .max(500)

// Slug validation (kebab-case)
createFAQGroupSchema.shape.slug
  .regex(/^[a-z0-9-]+$/)
  .max(140)

// Entity type validation
createFAQSchema.shape.entity_type
  .enum(['product', 'cms_page', 'collection', 'category', 'article'])
```

### Frontend Validation

```typescript
// Validation functions in utils.ts
validateQuestion(question: string): string | null
validateAnswer(answer: string): string | null
validateSlug(slug: string): string | null
validateEntityRelation(entityType, entityId): string | null
```

## Business Logic

### Slug Auto-Generation

When creating FAQ groups without a slug:
1. Name is converted to lowercase
2. Special characters removed
3. Spaces replaced with hyphens
4. Multiple hyphens collapsed
5. Leading/trailing hyphens removed

Example: `"Shipping & Returns"` → `"shipping-returns"`

### Publishing Workflow

When publishing an FAQ:
- `is_published` set to `true`
- `published_at` set to current timestamp
- FAQ becomes visible to customers

When unpublishing:
- `is_published` set to `false`
- `published_at` set to `NULL`
- FAQ hidden from customers (draft mode)

### Helpful Count

The `helpful_count` tracks customer feedback:
- Incremented via `POST /faqs/:id/helpful`
- Used for ranking/sorting popular FAQs
- Reset only by manual database update (intentional)

## Testing

### Backend Tests

```bash
# Run all tests
npm test

# Test specific module
npm test -- faqs
```

### Manual API Testing

```bash
# List FAQs
curl -X GET "http://localhost:3000/admin/api/v1/content/faqs?limit=10" \
  -H "Authorization: Bearer YOUR_TOKEN"

# Create FAQ
curl -X POST "http://localhost:3000/admin/api/v1/content/faqs" \
  -H "Authorization: Bearer YOUR_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "question": "Test question?",
    "answer": "<p>Test answer</p>",
    "is_published": false
  }'

# Publish FAQ
curl -X POST "http://localhost:3000/admin/api/v1/content/faqs/1/publish" \
  -H "Authorization: Bearer YOUR_TOKEN"
```

## Error Handling

### Common Errors

| Status | Error | Solution |
|--------|-------|----------|
| 400 | `Question is required` | Provide non-empty question |
| 400 | `Question must be 500 characters or less` | Shorten question |
| 400 | `Answer is required` | Provide non-empty answer |
| 400 | `Both entity_type and entity_id must be provided together` | Provide both or neither |
| 404 | `FAQ group not found` | Check group_id exists |
| 404 | `FAQ not found` | Check FAQ ID |
| 409 | `FAQ group slug already exists` | Use unique slug |
| 409 | `Cannot delete group with existing FAQs` | Remove or reassign FAQs first |

### Frontend Error Display

```typescript
try {
  await createMutation.mutateAsync(data)
  setSuccessMessage('FAQ created successfully')
} catch (err: any) {
  setErrorMessage(err?.message || 'Failed to create FAQ')
}
```

## Performance Considerations

### Database Indexes

Optimized queries for:
- Group filtering (`group_id` index)
- Entity lookups (`entity_type, entity_id` composite index)
- Published status (`is_published, sort_order` composite index)
- Search indexability (`is_indexable` index)

### Query Optimization

- Pagination prevents loading all records
- Joins limited to necessary fields
- COUNT queries use covering indexes

### Frontend Caching

React Query automatically caches:
- List queries (5 minutes default stale time)
- Detail queries (invalidated on mutations)
- Optimistic updates for better UX

## Migration Guide

### Adding FAQs to Existing Content

1. **Database:** Execute migration scripts in `database/` directory
2. **Permissions:** Add FAQ permissions to relevant roles
3. **Navigation:** Add FAQ menu items to admin navigation
4. **Routes:** Ensure routes are mounted in `app.ts`

### From Simple FAQ System

If migrating from a simple Q&A system:

```sql
-- Example migration
INSERT INTO cms_faq_groups (name, slug, sort_order, is_active)
VALUES ('General', 'general', 0, 1);

INSERT INTO cms_faqs (
  group_id, question, answer, sort_order, is_published, is_indexable
)
SELECT 
  1, -- general group
  old_question,
  old_answer,
  old_sort_order,
  1, -- publish all
  1  -- index all
FROM old_faqs_table;
```

## Troubleshooting

### FAQ Not Appearing

1. Check `is_published = true`
2. Verify group `is_active = true`
3. Check entity association is correct
4. Verify sort_order (lower numbers first)

### Slug Conflicts

1. Slugs must be unique within FAQ groups
2. Use `GET /faq-groups/slug/:slug` to check existence
3. Let system auto-generate or provide unique slug

### Rich Text Not Saving

1. Ensure answer contains valid HTML
2. Check for special characters/encoding issues
3. Verify TEXT field size limits in database

### Permission Errors

1. Verify user has `content.faqs.*` permissions
2. Check role assignments
3. Confirm authentication token is valid

## Future Enhancements

Potential improvements:

- [ ] Multi-language support
- [ ] FAQ categories within groups
- [ ] Related FAQs suggestions
- [ ] FAQ analytics dashboard
- [ ] Customer feedback/ratings
- [ ] AI-powered answer suggestions
- [ ] FAQ templates
- [ ] Import/export functionality
- [ ] Version history for answers
- [ ] FAQ search widget for storefront

## Support

For issues or questions:
- Check this documentation first
- Review database schema in `database/06_cms.sql`
- Check API logs for error details
- Review validation schemas in `faqs.schemas.ts`

## License

Proprietary - Veylog Platform
