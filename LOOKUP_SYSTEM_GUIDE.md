# Generic Lookup/Dropdown Management System

## 🎯 Overview

A **centralized, database-driven dropdown management system** that eliminates hardcoded frontend values. Used in enterprise banking and fintech companies for maintainability and scalability.

### Benefits
✅ **Single Source of Truth** - All dropdown values in database  
✅ **Dynamic Updates** - Change values without code deployment  
✅ **Admin-Friendly** - Non-technical staff can manage options  
✅ **Multilingual Ready** - Easy to add translations  
✅ **Audit Trail** - Track all changes to dropdown values  
✅ **Reusable** - One system for all dropdowns across the app  
✅ **No Frontend Changes** - Add new dropdowns without touching frontend code  

---

## 📊 Database Schema

### `lookup_categories` Table
Defines dropdown types (e.g., "benefits", "skin_types")

| Column | Type | Description |
|--------|------|-------------|
| id | BIGINT | Primary key |
| code | VARCHAR(100) | Unique identifier (e.g., "benefits") |
| name | VARCHAR(191) | Display name (e.g., "Product Benefits") |
| description | TEXT | What this lookup is for |
| is_active | BOOLEAN | Enable/disable category |
| allow_custom | BOOLEAN | Allow users to add custom values |
| sort_order | SMALLINT | Display order |

### `lookup_values` Table
Stores individual dropdown options

| Column | Type | Description |
|--------|------|-------------|
| id | BIGINT | Primary key |
| category_id | BIGINT | Foreign key to lookup_categories |
| code | VARCHAR(100) | Value identifier (e.g., "hydrating") |
| label | VARCHAR(191) | Display text (e.g., "Hydrating") |
| description | TEXT | Helper text or tooltip |
| icon | VARCHAR(191) | Icon name or URL |
| color | VARCHAR(20) | Badge/chip color (hex code) |
| metadata | JSON | Additional custom attributes |
| is_active | BOOLEAN | Enable/disable value |
| sort_order | SMALLINT | Display order within category |

---

## 🔌 API Endpoints

### Public Endpoints (No Authentication)

#### 1. Get All Dropdowns
```http
GET /admin/api/v1/lookups
```

**Response:**
```json
{
  "success": true,
  "lookups": {
    "benefits": [
      { "id": 1, "code": "hydrating", "label": "Hydrating", "sort_order": 1 },
      { "id": 2, "code": "anti_aging", "label": "Anti-Aging", "sort_order": 2 }
    ],
    "skin_types": [
      { "id": 10, "code": "dry", "label": "Dry", "color": "#E3F2FD" },
      { "id": 11, "code": "oily", "label": "Oily", "color": "#FFF9C4" }
    ],
    "finish": [
      { "id": 20, "code": "matte", "label": "Matte" },
      { "id": 21, "code": "dewy", "label": "Dewy" }
    ]
  }
}
```

#### 2. Get Specific Categories
```http
GET /admin/api/v1/lookups?categories=benefits,skin_types,skin_concerns
```

**Response:** Same structure, filtered to requested categories

#### 3. Get Single Category
```http
GET /admin/api/v1/lookups/benefits
```

**Response:**
```json
{
  "success": true,
  "category": "benefits",
  "values": [
    {
      "id": 1,
      "code": "hydrating",
      "label": "Hydrating",
      "description": "Provides moisture and hydration",
      "sort_order": 1
    }
  ]
}
```

#### 4. Get All Categories (Metadata)
```http
GET /admin/api/v1/lookups/categories
```

**Response:**
```json
{
  "success": true,
  "categories": [
    {
      "id": 1,
      "code": "benefits",
      "name": "Product Benefits",
      "description": "Cosmetic product benefits/claims",
      "allow_custom": true,
      "sort_order": 1
    }
  ]
}
```

#### 5. Search Values
```http
GET /admin/api/v1/lookups/search?q=hydrating
GET /admin/api/v1/lookups/search?q=anti&category=benefits
```

---

### Admin Endpoints (Authentication Required)

#### 6. Create Category
```http
POST /admin/api/v1/lookups/admin/categories
Authorization: Bearer <token>
Content-Type: application/json

{
  "code": "hair_type",
  "name": "Hair Types",
  "description": "Types of hair",
  "allow_custom": false,
  "sort_order": 20
}
```

#### 7. Update Category
```http
PUT /admin/api/v1/lookups/admin/categories/:id
Authorization: Bearer <token>

{
  "name": "Hair Type (Updated)",
  "is_active": true
}
```

#### 8. Create Value
```http
POST /admin/api/v1/lookups/admin/values
Authorization: Bearer <token>

{
  "category_id": 1,
  "code": "rejuvenating",
  "label": "Rejuvenating",
  "description": "Revitalizes tired skin",
  "color": "#E1BEE7",
  "sort_order": 16
}
```

#### 9. Update Value
```http
PUT /admin/api/v1/lookups/admin/values/:id
Authorization: Bearer <token>

{
  "label": "Anti-Aging & Rejuvenating",
  "is_active": true
}
```

#### 10. Delete Value
```http
DELETE /admin/api/v1/lookups/admin/values/:id
Authorization: Bearer <token>
```

#### 11. Reorder Values
```http
POST /admin/api/v1/lookups/admin/categories/1/reorder
Authorization: Bearer <token>

{
  "ordered_ids": [3, 1, 5, 2, 4]
}
```

---

## 💻 Frontend Integration

### React Hook Example

```typescript
// hooks/useLookups.ts
import { useQuery } from '@tanstack/react-query';
import { apiClient } from '../api/client';

interface LookupValue {
  id: number;
  code: string;
  label: string;
  description?: string;
  icon?: string;
  color?: string;
  sort_order: number;
}

interface LookupsResponse {
  success: true;
  lookups: Record<string, LookupValue[]>;
}

export function useLookups(categories?: string[]) {
  return useQuery({
    queryKey: ['lookups', categories],
    queryFn: async () => {
      const params = categories ? `?categories=${categories.join(',')}` : '';
      const response = await apiClient.get<LookupsResponse>(`/lookups${params}`);
      return response.data.lookups;
    },
    staleTime: 5 * 60 * 1000, // 5 minutes
    cacheTime: 30 * 60 * 1000, // 30 minutes
  });
}

// Usage
export function ProductForm() {
  const { data: lookups, isLoading } = useLookups([
    'benefits',
    'skin_types',
    'skin_concerns',
    'finish',
    'coverage',
  ]);

  if (isLoading) return <CircularProgress />;

  return (
    <form>
      {/* Benefits Multi-Select */}
      <Autocomplete
        multiple
        options={lookups?.benefits || []}
        getOptionLabel={(option) => option.label}
        renderInput={(params) => <TextField {...params} label="Benefits" />}
      />

      {/* Finish Dropdown */}
      <Select label="Finish">
        {(lookups?.finish || []).map((option) => (
          <MenuItem key={option.id} value={option.code}>
            {option.label}
          </MenuItem>
        ))}
      </Select>
    </form>
  );
}
```

---

## 🏗️ Current Dropdowns Seeded

The migration pre-populates these categories:

| Category Code | Name | Values Count | Use Case |
|---------------|------|--------------|----------|
| `benefits` | Product Benefits | 15 | Hydrating, Anti-Aging, Brightening, etc. |
| `skin_types` | Skin Types | 6 | Dry, Oily, Combination, Normal, Sensitive, Mature |
| `skin_concerns` | Skin Concerns | 12 | Fine Lines, Dark Spots, Acne, etc. |
| `finish` | Product Finish | 8 | Matte, Dewy, Natural, Satin, etc. |
| `coverage` | Coverage Level | 5 | Sheer, Light, Medium, Full, Buildable |
| `shade_family` | Shade Family | 4 | Warm, Cool, Neutral, Olive |
| `formulation_type` | Formulation Type | 10 | Cream, Gel, Serum, Oil, etc. |
| `absorption_rate` | Absorption Rate | 4 | Instant, Fast, Medium, Slow |
| `pregnancy_safe` | Pregnancy Safety | 3 | Safe, Consult Doctor, Not Recommended |
| `gender_target` | Gender Target | 4 | Unisex, Female, Male, Non-Binary |
| `season` | Season | 5 | Spring, Summer, Fall, Winter, All Year |
| `free_from` | Free From | 10 | Parabens, Sulfates, Phthalates, etc. |
| `claims` | Product Claims | 9 | Dermatologist Tested, Clinically Proven, etc. |
| `certification_type` | Certification Types | 8 | Cruelty-Free, Vegan, Organic, etc. |
| `packaging_type` | Packaging Types | 10 | Pump Bottle, Dropper, Jar, Tube, etc. |
| `application_method` | Application Methods | 8 | Fingertips, Brush, Sponge, etc. |
| `age_range` | Age Ranges | 6 | All Ages, 18-24, 25-35, 35-45, etc. |

**Total:** 17 categories, 100+ pre-populated values

---

## 🎨 Frontend Component Updates

### Before (Hardcoded)
```typescript
<Select label="Finish">
  <MenuItem value="">Not specified</MenuItem>
  <MenuItem value="matte">Matte</MenuItem>
  <MenuItem value="dewy">Dewy</MenuItem>
  <MenuItem value="natural">Natural</MenuItem>
</Select>
```

### After (Dynamic)
```typescript
const { data: lookups } = useLookups(['finish']);

<Select label="Finish">
  <MenuItem value="">Not specified</MenuItem>
  {(lookups?.finish || []).map((option) => (
    <MenuItem key={option.id} value={option.code}>
      {option.label}
    </MenuItem>
  ))}
</Select>
```

### Multi-Select with Colors
```typescript
const { data: lookups } = useLookups(['skin_types']);

<Autocomplete
  multiple
  options={lookups?.skin_types || []}
  getOptionLabel={(option) => option.label}
  renderTags={(value, getTagProps) =>
    value.map((option, index) => (
      <Chip
        label={option.label}
        {...getTagProps({ index })}
        style={{ backgroundColor: option.color }}
      />
    ))
  }
/>
```

---

## 🔄 Migration Path

### Step 1: Run Database Migration
```bash
cd d:\veylog-backend
mysql -u root -p veylog_db < database/26_lookup_tables.sql
```

### Step 2: Test API
```bash
# Get all lookups
curl http://localhost:3000/admin/api/v1/lookups

# Get specific category
curl http://localhost:3000/admin/api/v1/lookups/benefits
```

### Step 3: Update Frontend

1. **Create React Hook** (`useLookups.ts`)
2. **Update Product Form** - Replace hardcoded dropdowns
3. **Test** - Verify dropdowns populate from API

---

## 🛠️ Admin UI Features (To Build)

### Lookups Management Page

**Features:**
- List all categories
- Add/edit/delete categories
- List values per category
- Add/edit/delete values
- Drag-and-drop reordering
- Bulk import/export
- Search and filter

**Wireframe:**
```
┌─────────────────────────────────────────────────┐
│  Lookups Management                             │
│  ┌──────────────────┬──────────────────────┐   │
│  │  Categories      │  Values              │   │
│  │                  │                      │   │
│  │  ▶ Benefits (15) │  ☰ Hydrating        │   │
│  │  ▼ Skin Types(6) │  ☰ Anti-Aging       │   │
│  │    • Dry         │  ☰ Brightening      │   │
│  │    • Oily        │  ☰ Plumping         │   │
│  │    • Normal      │  [+Add Value]       │   │
│  │  ▶ Finish (8)    │                      │   │
│  │  [+Add Category] │                      │   │
│  └──────────────────┴──────────────────────┘   │
└─────────────────────────────────────────────────┘
```

---

## 🌍 Internationalization (Future)

### Add `lookup_value_translations` Table
```sql
CREATE TABLE lookup_value_translations (
  id BIGINT UNSIGNED PRIMARY KEY AUTO_INCREMENT,
  lookup_value_id BIGINT UNSIGNED NOT NULL,
  locale VARCHAR(10) NOT NULL,
  label VARCHAR(191) NOT NULL,
  description TEXT NULL,
  
  FOREIGN KEY (lookup_value_id) REFERENCES lookup_values(id),
  UNIQUE KEY (lookup_value_id, locale)
);

-- Example data
INSERT INTO lookup_value_translations VALUES
(1, 1, 'en', 'Hydrating', 'Provides moisture'),
(2, 1, 'hi', 'हाइड्रेटिंग', 'नमी प्रदान करता है'),
(3, 1, 'es', 'Hidratante', 'Proporciona humedad');
```

---

## 📈 Performance Optimization

### Caching Strategy

1. **Frontend Cache:** React Query with 5-minute stale time
2. **Backend Cache:** Redis with 10-minute TTL
3. **CDN Cache:** CloudFlare with 1-hour cache

```typescript
// Add caching middleware
import { cache } from '../../middleware/cache';

router.get('/', cache(600), controller.getAllValues); // 10 min
router.get('/:categoryCode', cache(600), controller.getValuesByCategory);
```

---

## 🔐 Permissions

Add these permissions to your RBAC system:

| Permission | Description |
|------------|-------------|
| `lookups.view` | View lookup values (public) |
| `lookups.create` | Create categories/values |
| `lookups.update` | Update categories/values |
| `lookups.delete` | Delete categories/values |

---

## 📝 Use Cases

### 1. Product Filters
```typescript
// Shop page filters
const { data: lookups } = useLookups(['skin_types', 'skin_concerns', 'finish']);

<FilterSidebar>
  <FilterGroup title="Skin Type">
    {lookups?.skin_types.map(type => (
      <Checkbox label={type.label} value={type.code} />
    ))}
  </FilterGroup>
</FilterSidebar>
```

### 2. Dynamic Form Builder
```typescript
// Generic form from config
const formConfig = [
  { field: 'benefits', type: 'multiselect', lookup: 'benefits' },
  { field: 'finish', type: 'select', lookup: 'finish' },
];

formConfig.map(config => (
  <DynamicField {...config} options={lookups[config.lookup]} />
));
```

### 3. Bulk Product Import
```typescript
// CSV import with validation
const validateBenefits = (csvValue: string) => {
  const validCodes = lookups.benefits.map(b => b.code);
  return csvValue.split(',').every(code => validCodes.includes(code.trim()));
};
```

---

## 🎯 Advantages Over Hardcoded Dropdowns

| Aspect | Hardcoded | Dynamic Lookups |
|--------|-----------|-----------------|
| **Add new option** | Code change + deploy | Admin UI, instant |
| **Reorder options** | Code change + deploy | Drag & drop |
| **Deactivate option** | Code change + deploy | Toggle switch |
| **Multilingual** | Separate codebases | One translation table |
| **Audit trail** | None | Full history |
| **Consistency** | Manual sync | Single source |
| **Performance** | Bundled in JS | Cached API call |

---

## 🚀 Next Steps

1. ✅ Run migration `26_lookup_tables.sql`
2. ✅ API endpoints ready
3. 🔜 Build admin UI for managing lookups
4. 🔜 Update product form to use dynamic dropdowns
5. 🔜 Add caching layer (Redis)
6. 🔜 Build CSV import/export
7. 🔜 Add internationalization support

---

**Result:** Enterprise-grade dropdown management system! 🎉
