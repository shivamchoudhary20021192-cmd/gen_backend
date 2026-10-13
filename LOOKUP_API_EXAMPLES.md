# Lookup API - Quick Examples & Testing

## 🚀 Quick Test Commands

### 1. Get All Lookups (All Categories)
```bash
curl http://localhost:3000/admin/api/v1/lookups
```

**Example Response:**
```json
{
  "success": true,
  "lookups": {
    "benefits": [
      {
        "id": 1,
        "code": "hydrating",
        "label": "Hydrating",
        "description": "Provides moisture and hydration",
        "icon": null,
        "color": null,
        "metadata": null,
        "sort_order": 1
      },
      {
        "id": 2,
        "code": "anti_aging",
        "label": "Anti-Aging",
        "description": "Reduces signs of aging",
        "icon": null,
        "color": null,
        "metadata": null,
        "sort_order": 2
      }
    ],
    "skin_types": [
      {
        "id": 10,
        "code": "dry",
        "label": "Dry",
        "description": "Lacks moisture, feels tight",
        "icon": null,
        "color": "#E3F2FD",
        "metadata": null,
        "sort_order": 1
      }
    ]
  }
}
```

---

### 2. Get Specific Categories
```bash
# Only benefits, skin_types, and finish
curl "http://localhost:3000/admin/api/v1/lookups?categories=benefits,skin_types,finish"
```

**Use Case:** Load only the dropdowns needed for a specific page

---

### 3. Get Single Category
```bash
curl http://localhost:3000/admin/api/v1/lookups/benefits
```

**Response:**
```json
{
  "success": true,
  "category": "benefits",
  "values": [
    { "id": 1, "code": "hydrating", "label": "Hydrating", "sort_order": 1 },
    { "id": 2, "code": "anti_aging", "label": "Anti-Aging", "sort_order": 2 },
    { "id": 3, "code": "brightening", "label": "Brightening", "sort_order": 3 }
  ]
}
```

---

### 4. Get Categories Metadata
```bash
curl http://localhost:3000/admin/api/v1/lookups/categories
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
    },
    {
      "id": 2,
      "code": "skin_types",
      "name": "Skin Types",
      "description": "Suitable skin types",
      "allow_custom": false,
      "sort_order": 2
    }
  ]
}
```

---

### 5. Search Lookup Values
```bash
# Search all categories
curl "http://localhost:3000/admin/api/v1/lookups/search?q=hydrating"

# Search within specific category
curl "http://localhost:3000/admin/api/v1/lookups/search?q=anti&category=benefits"
```

**Response:**
```json
{
  "success": true,
  "query": "hydrating",
  "results": [
    {
      "id": 1,
      "category_id": 1,
      "code": "hydrating",
      "label": "Hydrating",
      "description": "Provides moisture and hydration",
      "category_code": "benefits",
      "category_name": "Product Benefits",
      "sort_order": 1
    }
  ]
}
```

---

## 🔐 Admin Operations (With Authentication)

### 6. Create New Category
```bash
curl -X POST http://localhost:3000/admin/api/v1/lookups/admin/categories \
  -H "Authorization: Bearer YOUR_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "code": "hair_type",
    "name": "Hair Types",
    "description": "Types of hair for product targeting",
    "allow_custom": false,
    "sort_order": 18
  }'
```

**Response:**
```json
{
  "success": true,
  "category_id": 18,
  "message": "Lookup category created"
}
```

---

### 7. Create New Value
```bash
curl -X POST http://localhost:3000/admin/api/v1/lookups/admin/values \
  -H "Authorization: Bearer YOUR_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "category_id": 1,
    "code": "detoxifying",
    "label": "Detoxifying",
    "description": "Removes impurities and toxins",
    "color": "#B2DFDB",
    "sort_order": 16
  }'
```

**Response:**
```json
{
  "success": true,
  "value_id": 101,
  "message": "Lookup value created"
}
```

---

### 8. Update Value
```bash
curl -X PUT http://localhost:3000/admin/api/v1/lookups/admin/values/101 \
  -H "Authorization: Bearer YOUR_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "label": "Detoxifying & Purifying",
    "description": "Deep cleanses and removes impurities",
    "is_active": true
  }'
```

---

### 9. Reorder Values
```bash
curl -X POST http://localhost:3000/admin/api/v1/lookups/admin/categories/1/reorder \
  -H "Authorization: Bearer YOUR_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "ordered_ids": [3, 1, 2, 5, 4, 6]
  }'
```

**Use Case:** After drag-and-drop in admin UI

---

### 10. Delete Value
```bash
curl -X DELETE http://localhost:3000/admin/api/v1/lookups/admin/values/101 \
  -H "Authorization: Bearer YOUR_TOKEN"
```

---

## 📱 Frontend Integration Examples

### React Query Hook
```typescript
// hooks/useLookups.ts
import { useQuery } from '@tanstack/react-query';
import { apiClient } from '../api/client';

export function useLookups(categories?: string[]) {
  return useQuery({
    queryKey: ['lookups', categories],
    queryFn: async () => {
      const params = categories ? `?categories=${categories.join(',')}` : '';
      const { data } = await apiClient.get(`/lookups${params}`);
      return data.lookups;
    },
    staleTime: 5 * 60 * 1000, // 5 min
  });
}

// Usage in component
function ProductForm() {
  const { data: lookups, isLoading } = useLookups([
    'benefits',
    'skin_types',
    'finish'
  ]);

  if (isLoading) return <CircularProgress />;

  return (
    <Autocomplete
      multiple
      options={lookups?.benefits || []}
      getOptionLabel={(option) => option.label}
      renderInput={(params) => <TextField {...params} label="Benefits" />}
    />
  );
}
```

---

### Vanilla JavaScript (Fetch)
```javascript
// Load all lookups
fetch('http://localhost:3000/admin/api/v1/lookups')
  .then(res => res.json())
  .then(data => {
    console.log('Benefits:', data.lookups.benefits);
    console.log('Skin Types:', data.lookups.skin_types);
  });

// Load specific categories
fetch('http://localhost:3000/admin/api/v1/lookups?categories=benefits,finish')
  .then(res => res.json())
  .then(data => {
    populateBenefitsDropdown(data.lookups.benefits);
    populateFinishDropdown(data.lookups.finish);
  });
```

---

### Axios Example
```javascript
import axios from 'axios';

// Create axios instance
const api = axios.create({
  baseURL: 'http://localhost:3000/admin/api/v1',
});

// Load lookups
async function loadDropdowns() {
  const { data } = await api.get('/lookups', {
    params: { categories: 'benefits,skin_types,finish' }
  });
  
  return data.lookups;
}

// Usage
const lookups = await loadDropdowns();
console.log(lookups.benefits);
```

---

## 🎯 Common Use Cases

### 1. Product Form - Load All Product-Related Dropdowns
```bash
curl "http://localhost:3000/admin/api/v1/lookups?categories=benefits,skin_types,skin_concerns,finish,coverage,formulation_type,absorption_rate,pregnancy_safe,gender_target,season,free_from,claims,certification_type,packaging_type,application_method,age_range"
```

### 2. Shop Filters - Load Filter Options
```bash
curl "http://localhost:3000/admin/api/v1/lookups?categories=skin_types,skin_concerns,benefits,finish,free_from"
```

### 3. Checkout - Load Payment/Shipping Options
```bash
curl "http://localhost:3000/admin/api/v1/lookups?categories=payment_methods,shipping_methods"
```

---

## 🧪 Testing Checklist

### Basic Functionality
- [ ] GET /lookups returns all categories
- [ ] GET /lookups?categories=X filters correctly
- [ ] GET /lookups/:code returns single category
- [ ] GET /lookups/categories returns metadata
- [ ] GET /lookups/search works
- [ ] Values sorted by sort_order
- [ ] Only active values returned

### Admin Operations
- [ ] POST create category works
- [ ] PUT update category works
- [ ] POST create value works
- [ ] PUT update value works
- [ ] DELETE soft-deletes value
- [ ] POST reorder updates sort_order

### Edge Cases
- [ ] Invalid category returns empty array
- [ ] Search with < 2 chars returns error
- [ ] Inactive categories not returned
- [ ] Inactive values not returned

---

## 📊 Performance Testing

### Load Test
```bash
# Apache Bench
ab -n 1000 -c 10 http://localhost:3000/admin/api/v1/lookups

# Expected: < 100ms average response time
```

### Cache Test
```bash
# First request (cold cache)
time curl http://localhost:3000/admin/api/v1/lookups

# Second request (warm cache)
time curl http://localhost:3000/admin/api/v1/lookups

# Should be significantly faster
```

---

## 🐛 Troubleshooting

### Issue: Empty Response
```bash
# Check if categories exist
mysql -u root -p veylog_db -e "SELECT * FROM lookup_categories LIMIT 5;"

# Check if values exist
mysql -u root -p veylog_db -e "SELECT * FROM lookup_values LIMIT 10;"
```

### Issue: "Category not found"
```bash
# Verify category code
curl http://localhost:3000/admin/api/v1/lookups/categories | jq '.categories[].code'
```

### Issue: Unauthorized for Admin Endpoints
```bash
# Get auth token first
curl -X POST http://localhost:3000/admin/api/v1/auth/login \
  -H "Content-Type: application/json" \
  -d '{"email":"admin@example.com","password":"password"}'

# Use returned token
export TOKEN="your_token_here"
curl -H "Authorization: Bearer $TOKEN" \
  http://localhost:3000/admin/api/v1/lookups/admin/categories
```

---

## 📈 Monitoring

### Key Metrics to Track
- Request count per endpoint
- Average response time
- Cache hit ratio
- Most accessed categories
- Admin modifications frequency

### Logging
```typescript
// Add logging middleware
router.get('/', (req, res, next) => {
  console.log('Lookups accessed:', req.query.categories);
  next();
}, controller.getAllValues);
```

---

## 🎓 Best Practices

1. **Always specify categories** when you know which ones you need
   ```typescript
   // ✅ Good
   useLookups(['benefits', 'skin_types'])
   
   // ❌ Avoid (loads everything)
   useLookups()
   ```

2. **Cache aggressively** - Lookup data changes rarely
   ```typescript
   staleTime: 5 * 60 * 1000 // 5 minutes
   ```

3. **Use codes, not IDs** - Codes are stable, IDs may change
   ```typescript
   // ✅ Good
   coverage: 'medium'
   
   // ❌ Avoid
   coverage_id: 42
   ```

4. **Validate against lookup codes** - Before saving to database
   ```typescript
   const validBenefits = lookups.benefits.map(b => b.code);
   if (!validBenefits.includes(selectedBenefit)) {
     throw new Error('Invalid benefit');
   }
   ```

---

**Ready to use! 🚀**
