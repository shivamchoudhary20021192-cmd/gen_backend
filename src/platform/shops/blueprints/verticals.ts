import type { CategorySeed, CollectionSeed, LookupSeed, VerticalBlueprint } from './types';

/**
 * What a shop sells decides its starting catalogue shape.
 *
 * Each vertical brings the product attributes merchants in it actually filter
 * and shop by (lookups become facet values; metafields become product fields
 * in the admin and filters on the storefront), a category tree to start from,
 * collections, search synonyms for the words shoppers type, and the theme it
 * opens with. Everything is a starting point: merchants rename, delete and
 * extend all of it.
 */

const values = (...entries: string[]) =>
  entries.map((label) => ({ code: label.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, ''), label }));

/** Values whose codes are fixed by data already stored against them (the legacy seed's), not derived from the label. */
const coded = (...entries: [string, string][]) => entries.map(([code, label]) => ({ code, label }));

const category = (name: string, children: string[] = [], description?: string): CategorySeed => ({
  name,
  slug: name.toLowerCase().replace(/&/g, 'and').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, ''),
  description,
  children: children.map((child) => category(child)),
});

const STANDARD_COLLECTIONS: CollectionSeed[] = [
  { slug: 'new-arrivals', title: 'New arrivals', subtitle: 'The latest additions', sortType: 'newest', showInMenu: true },
  { slug: 'best-sellers', title: 'Best sellers', subtitle: 'What everyone is buying', sortType: 'best_selling', showInMenu: true },
  { slug: 'sale', title: 'Sale', subtitle: 'Limited-time offers', sortType: 'price_asc', showInMenu: false },
];

const GENDER: LookupSeed = { code: 'gender', name: 'Gender', values: values('Women', 'Men', 'Unisex', 'Girls', 'Boys') };

const GENERAL: VerticalBlueprint = {
  key: 'general',
  name: 'General store',
  description: 'A bit of everything. Start broad and shape it as you go.',
  theme: 'aurora',
  lookups: [
    { code: 'material', name: 'Material', allowCustom: true, values: values('Cotton', 'Wood', 'Metal', 'Glass', 'Plastic', 'Leather', 'Ceramic') },
    { code: 'color', name: 'Colour', allowCustom: true, values: values('Black', 'White', 'Grey', 'Blue', 'Red', 'Green', 'Yellow', 'Pink', 'Brown', 'Beige') },
  ],
  metafields: [
    { ownerType: 'product', key: 'care_instructions', name: 'Care instructions', type: 'multi_line_text_field' },
    { ownerType: 'product', key: 'country_of_origin', name: 'Country of origin', type: 'single_line_text_field', filterable: true },
    { ownerType: 'product', key: 'warranty_months', name: 'Warranty (months)', type: 'number_integer' },
  ],
  categories: [category('Featured'), category('Home'), category('Accessories'), category('Gifts')],
  collections: STANDARD_COLLECTIONS,
  searchSynonyms: [{ term: 'present', synonyms: ['gift', 'gifts'] }],
  hero: { heading: 'Welcome to our store', body: 'Thoughtfully chosen things, delivered to your door.', cta: 'Shop now' },
  promises: [
    { icon: 'truck', title: 'Fast delivery', body: 'Dispatched within two working days.' },
    { icon: 'check', title: 'Easy returns', body: 'Changed your mind? Send it back.' },
    { icon: 'shield', title: 'Secure checkout', body: 'Your payment details stay private.' },
  ],
};

const FASHION: VerticalBlueprint = {
  key: 'fashion',
  name: 'Fashion & apparel',
  description: 'Clothing, footwear and accessories with sizes, colours and fits.',
  theme: 'atelier',
  lookups: [
    GENDER,
    { code: 'size', name: 'Size', values: values('XXS', 'XS', 'S', 'M', 'L', 'XL', 'XXL', '3XL') },
    { code: 'shoe_size', name: 'Shoe size', allowCustom: true, values: values('5', '6', '7', '8', '9', '10', '11', '12') },
    { code: 'color', name: 'Colour', allowCustom: true, values: values('Black', 'White', 'Navy', 'Grey', 'Beige', 'Olive', 'Red', 'Blue', 'Pink', 'Green', 'Brown') },
    { code: 'fit', name: 'Fit', values: values('Slim', 'Regular', 'Relaxed', 'Oversized', 'Tailored') },
    { code: 'fabric', name: 'Fabric', allowCustom: true, values: values('Cotton', 'Linen', 'Silk', 'Wool', 'Denim', 'Polyester', 'Viscose', 'Leather') },
    { code: 'occasion', name: 'Occasion', values: values('Casual', 'Work', 'Party', 'Wedding', 'Festive', 'Sport', 'Lounge') },
    { code: 'season', name: 'Season', values: values('Spring', 'Summer', 'Autumn', 'Winter', 'All season') },
  ],
  metafields: [
    { ownerType: 'product', key: 'size_chart', name: 'Size chart', type: 'file_reference' },
    { ownerType: 'product', key: 'fabric_composition', name: 'Fabric composition', type: 'single_line_text_field', filterable: true },
    { ownerType: 'product', key: 'care_instructions', name: 'Care instructions', type: 'multi_line_text_field' },
    { ownerType: 'product', key: 'model_info', name: 'Model is wearing', type: 'single_line_text_field', description: 'e.g. "Model is 5\'9" and wears S"' },
    { ownerType: 'product', key: 'sustainability', name: 'Sustainability notes', type: 'multi_line_text_field' },
  ],
  categories: [
    category('Women', ['Dresses', 'Tops', 'Bottoms', 'Outerwear', 'Ethnic wear']),
    category('Men', ['Shirts', 'T-shirts', 'Trousers', 'Jackets', 'Ethnic wear']),
    category('Footwear', ['Sneakers', 'Formal', 'Sandals', 'Boots']),
    category('Accessories', ['Bags', 'Belts', 'Scarves', 'Hats']),
    category('Kids'),
  ],
  collections: [...STANDARD_COLLECTIONS, { slug: 'essentials', title: 'Wardrobe essentials', sortType: 'manual', showInMenu: true }],
  searchSynonyms: [
    { term: 'tee', synonyms: ['t-shirt', 'tshirt'] },
    { term: 'pants', synonyms: ['trousers'] },
    { term: 'sneakers', synonyms: ['trainers', 'shoes'] },
    { term: 'kurta', synonyms: ['kurti'] },
  ],
  hero: { heading: 'The new season is here', body: 'Pieces made to be worn, washed and worn again.', cta: 'Shop the collection' },
  promises: [
    { icon: 'check', title: 'Find your fit', body: 'Size guides on every product.' },
    { icon: 'check', title: 'Free exchanges', body: 'Wrong size? We will swap it.' },
    { icon: 'truck', title: 'Fast delivery', body: 'Dispatched within two working days.' },
    { icon: 'leaf', title: 'Made responsibly', body: 'Fabrics we can stand behind.' },
  ],
};

const BEAUTY: VerticalBlueprint = {
  key: 'beauty',
  name: 'Beauty & skincare',
  description: 'Skincare, makeup, haircare and fragrance with ingredients and skin types.',
  theme: 'lumen',
  lookups: [
    { code: 'skin_types', name: 'Skin type', values: values('Dry', 'Oily', 'Combination', 'Normal', 'Sensitive', 'Mature') },
    { code: 'skin_concerns', name: 'Skin concern', allowCustom: true, values: values('Fine lines', 'Dark spots', 'Dullness', 'Uneven tone', 'Acne', 'Large pores', 'Redness', 'Dehydration', 'Texture', 'Dark circles') },
    { code: 'benefits', name: 'Benefit', allowCustom: true, values: values('Hydrating', 'Brightening', 'Firming', 'Soothing', 'Exfoliating', 'Oil control', 'Protecting', 'Nourishing') },
    { code: 'formulation_type', name: 'Formulation', allowCustom: true, values: values('Cream', 'Gel', 'Serum', 'Oil', 'Lotion', 'Balm', 'Foam', 'Powder', 'Liquid') },
    { code: 'free_from', name: 'Free from', values: values('Parabens', 'Sulfates', 'Phthalates', 'Mineral oil', 'Fragrance', 'Silicones', 'Alcohol') },
    { code: 'certification_type', name: 'Certification', values: values('Cruelty free', 'Vegan', 'Organic', 'Dermatologist tested', 'Halal') },
    { code: 'finish', name: 'Finish', values: values('Matte', 'Dewy', 'Natural', 'Satin', 'Radiant') },
    // The rest of what the product form asks for, with the codes the founding store uses.
    { code: 'gender_target', name: 'Gender', values: coded(['unisex', 'Unisex'], ['female', 'Female'], ['male', 'Male'], ['non_binary', 'Non-Binary']) },
    { code: 'age_range', name: 'Age range', values: coded(['all_ages', 'All Ages'], ['18_24', '18-24'], ['25_35', '25-35'], ['35_45', '35-45'], ['45_plus', '45+'], ['55_plus', '55+']) },
    { code: 'coverage', name: 'Coverage', values: values('Sheer', 'Light', 'Medium', 'Full', 'Buildable') },
    { code: 'shade_family', name: 'Shade family', values: values('Warm', 'Cool', 'Neutral', 'Olive') },
    { code: 'absorption_rate', name: 'Absorption', values: values('Instant', 'Fast', 'Medium', 'Slow') },
    { code: 'feel_on_skin', name: 'Feel on skin', allowCustom: true, values: values('Lightweight', 'Silky', 'Velvety', 'Smooth', 'Cooling', 'Soothing', 'Non-Sticky', 'Non-Greasy', 'Fast Absorbing', 'Hydrating', 'Nourishing', 'Cushiony', 'Weightless', 'Comfortable', 'Breathable', 'Tightening') },
    { code: 'pregnancy_safe', name: 'Pregnancy safety', values: values('Safe', 'Consult Doctor', 'Not Recommended') },
    { code: 'season', name: 'Season', values: values('Spring', 'Summer', 'Fall', 'Winter', 'All Year') },
    { code: 'claims', name: 'Claims', allowCustom: true, values: values('Dermatologist Tested', 'Clinically Proven', 'Allergy Tested', 'Ophthalmologist Tested', 'Non-Irritating', 'Fragrance Free', 'Oil Free', 'Water Resistant', 'Long Lasting') },
    { code: 'packaging_type', name: 'Packaging', allowCustom: true, values: values('Pump Bottle', 'Dropper Bottle', 'Jar', 'Tube', 'Spray Bottle', 'Stick', 'Compact', 'Pen', 'Sachet', 'Ampoule') },
    { code: 'application_method', name: 'Application method', allowCustom: true, values: values('Fingertips', 'Palms', 'Cotton Pad', 'Brush', 'Sponge', 'Applicator', 'Roller', 'Spray') },
    {
      code: 'usage_instructions',
      name: 'Usage instructions',
      allowCustom: true,
      values: coded(
        ['apply_am_pm', 'Apply morning and evening'],
        ['apply_clean_skin', 'Apply to clean, dry skin'],
        ['apply_damp_skin', 'Apply to clean, damp skin'],
        ['apply_2_3_drops', 'Apply 2-3 drops'],
        ['apply_thin_layer', 'Apply a thin layer'],
        ['apply_generous_amount', 'Apply a generous amount'],
        ['massage_gently', 'Massage gently into skin'],
        ['pat_until_absorbed', 'Pat until fully absorbed'],
        ['use_before_moisturizer', 'Use before moisturizer'],
        ['use_after_serum', 'Use after serum'],
        ['avoid_eye_area', 'Avoid eye area'],
        ['use_sunscreen_after', 'Follow with sunscreen (AM)'],
        ['use_2_3_times_week', 'Use 2-3 times per week'],
        ['leave_on_overnight', 'Leave on overnight'],
        ['rinse_after_10_min', 'Rinse after 10-15 minutes'],
      ),
    },
  ],
  metafields: [
    { ownerType: 'product', key: 'key_ingredients', name: 'Key ingredients', type: 'multi_line_text_field' },
    { ownerType: 'product', key: 'full_ingredients', name: 'Full ingredient list (INCI)', type: 'multi_line_text_field' },
    { ownerType: 'product', key: 'how_to_use', name: 'How to use', type: 'rich_text_field' },
    { ownerType: 'product', key: 'spf_rating', name: 'SPF rating', type: 'number_integer', filterable: true },
    { ownerType: 'product', key: 'ph_value', name: 'Formula pH', type: 'number_decimal' },
    { ownerType: 'product', key: 'vegan', name: 'Vegan', type: 'boolean', filterable: true },
    { ownerType: 'product', key: 'patch_test_required', name: 'Patch test recommended', type: 'boolean' },
  ],
  categories: [
    category('Skincare', ['Cleansers', 'Toners', 'Serums', 'Moisturisers', 'Sunscreen', 'Masks']),
    category('Makeup', ['Face', 'Eyes', 'Lips', 'Nails']),
    category('Haircare', ['Shampoo', 'Conditioner', 'Treatments', 'Styling']),
    category('Body', ['Body wash', 'Body lotion', 'Hand care']),
    category('Fragrance'),
    category('Sets & gifts'),
  ],
  collections: [...STANDARD_COLLECTIONS, { slug: 'routines', title: 'Complete routines', sortType: 'manual', showInMenu: true }],
  searchSynonyms: [
    { term: 'moisturiser', synonyms: ['moisturizer', 'cream'] },
    { term: 'sunscreen', synonyms: ['spf', 'sunblock'] },
    { term: 'vitamin c', synonyms: ['ascorbic acid', 'vit c'] },
    { term: 'retinol', synonyms: ['retinoid', 'vitamin a'] },
  ],
  hero: { heading: 'Skincare that shows its working', body: 'Every active named, every percentage printed on the box.', cta: 'Find your routine' },
  promises: [
    { icon: 'flask', title: 'Tested formulas', body: 'Dermatologist tested, every one.' },
    { icon: 'leaf', title: 'Clean ingredients', body: 'Nothing we would not use ourselves.' },
    { icon: 'shield', title: 'Cruelty free', body: 'Never tested on animals.' },
    { icon: 'truck', title: 'Fast delivery', body: 'Dispatched within a day.' },
  ],
};

const ELECTRONICS: VerticalBlueprint = {
  key: 'electronics',
  name: 'Electronics & gadgets',
  description: 'Devices and accessories with specifications, compatibility and warranty.',
  theme: 'circuit',
  lookups: [
    { code: 'brand', name: 'Brand', allowCustom: true, values: values('Apple', 'Samsung', 'Sony', 'Xiaomi', 'OnePlus', 'Lenovo', 'HP', 'JBL', 'Anker') },
    { code: 'connectivity', name: 'Connectivity', values: values('Bluetooth', 'Wi-Fi', 'USB-C', 'Lightning', 'NFC', '5G', 'Wired') },
    { code: 'compatibility', name: 'Works with', allowCustom: true, values: values('iPhone', 'Android', 'Windows', 'macOS', 'iPad', 'Smart TV') },
    { code: 'storage', name: 'Storage', values: values('64 GB', '128 GB', '256 GB', '512 GB', '1 TB', '2 TB') },
    { code: 'memory', name: 'Memory (RAM)', values: values('4 GB', '8 GB', '16 GB', '32 GB', '64 GB') },
    { code: 'condition', name: 'Condition', values: values('New', 'Renewed', 'Open box') },
  ],
  metafields: [
    { ownerType: 'product', key: 'specifications', name: 'Specifications', type: 'json', description: 'Key/value table shown on the product page.' },
    { ownerType: 'product', key: 'warranty_months', name: 'Warranty (months)', type: 'number_integer', filterable: true },
    { ownerType: 'product', key: 'model_number', name: 'Model number', type: 'single_line_text_field' },
    { ownerType: 'product', key: 'in_the_box', name: 'In the box', type: 'multi_line_text_field' },
    { ownerType: 'product', key: 'manual', name: 'User manual', type: 'file_reference' },
    { ownerType: 'variant', key: 'gtin', name: 'GTIN / EAN', type: 'single_line_text_field' },
  ],
  categories: [
    category('Phones & tablets', ['Smartphones', 'Tablets', 'Cases & covers', 'Chargers']),
    category('Computers', ['Laptops', 'Desktops', 'Monitors', 'Keyboards & mice']),
    category('Audio', ['Headphones', 'Earbuds', 'Speakers']),
    category('Wearables', ['Smartwatches', 'Fitness bands']),
    category('Smart home'),
    category('Cameras'),
    category('Accessories', ['Cables', 'Power banks', 'Storage']),
  ],
  collections: [...STANDARD_COLLECTIONS, { slug: 'deals', title: 'Deals of the week', sortType: 'price_asc', showInMenu: true }],
  searchSynonyms: [
    { term: 'earphones', synonyms: ['earbuds', 'headphones'] },
    { term: 'charger', synonyms: ['adapter', 'power adapter'] },
    { term: 'laptop', synonyms: ['notebook'] },
    { term: 'mobile', synonyms: ['phone', 'smartphone'] },
  ],
  hero: { heading: 'The latest tech, with a proper warranty', body: 'Genuine products, tested before they ship.', cta: 'Shop devices' },
  promises: [
    { icon: 'shield', title: 'Genuine products', body: 'Sourced from authorised distributors.' },
    { icon: 'shield', title: 'Warranty included', body: 'Manufacturer warranty on every device.' },
    { icon: 'truck', title: 'Insured shipping', body: 'Every parcel insured in transit.' },
    { icon: 'check', title: 'Real support', body: 'Help from people who know the kit.' },
  ],
};

const GROCERY: VerticalBlueprint = {
  key: 'grocery',
  name: 'Food & grocery',
  description: 'Packaged food, fresh produce and pantry staples with diets, allergens and shelf life.',
  theme: 'harvest',
  lookups: [
    { code: 'diet', name: 'Diet', values: values('Vegetarian', 'Vegan', 'Gluten free', 'Keto', 'Sugar free', 'Organic', 'High protein') },
    { code: 'allergens', name: 'Contains', values: values('Milk', 'Eggs', 'Peanuts', 'Tree nuts', 'Soy', 'Wheat', 'Fish', 'Shellfish', 'Sesame') },
    { code: 'storage', name: 'Storage', values: values('Ambient', 'Chilled', 'Frozen') },
    { code: 'pack_size', name: 'Pack size', allowCustom: true, values: values('100 g', '250 g', '500 g', '1 kg', '5 kg', '500 ml', '1 L') },
  ],
  metafields: [
    { ownerType: 'product', key: 'ingredients', name: 'Ingredients', type: 'multi_line_text_field' },
    { ownerType: 'product', key: 'nutrition', name: 'Nutrition per 100 g', type: 'json' },
    { ownerType: 'product', key: 'shelf_life_days', name: 'Shelf life (days)', type: 'number_integer' },
    { ownerType: 'product', key: 'veg_mark', name: 'Vegetarian mark', type: 'boolean', filterable: true },
    { ownerType: 'product', key: 'food_license', name: 'Food licence number', type: 'single_line_text_field' },
  ],
  categories: [
    category('Fruits & vegetables'),
    category('Dairy & eggs'),
    category('Bakery'),
    category('Pantry', ['Rice & grains', 'Flour', 'Oils', 'Spices', 'Pulses']),
    category('Snacks', ['Chips', 'Biscuits', 'Chocolate', 'Dry fruits']),
    category('Beverages', ['Tea', 'Coffee', 'Juices']),
    category('Frozen'),
  ],
  collections: [...STANDARD_COLLECTIONS, { slug: 'healthy', title: 'Healthy picks', sortType: 'manual', showInMenu: true }],
  searchSynonyms: [
    { term: 'curd', synonyms: ['yogurt', 'yoghurt', 'dahi'] },
    { term: 'aubergine', synonyms: ['eggplant', 'brinjal'] },
    { term: 'coriander', synonyms: ['cilantro', 'dhania'] },
  ],
  hero: { heading: 'Fresh groceries, delivered', body: 'From farms and kitchens we know, to your door.', cta: 'Start shopping' },
  promises: [
    { icon: 'leaf', title: 'Fresh every day', body: 'Stock turned over daily.' },
    { icon: 'truck', title: 'Delivery slots', body: 'Choose a time that suits you.' },
    { icon: 'shield', title: 'Cold chain', body: 'Chilled items stay chilled.' },
  ],
};

const HOME: VerticalBlueprint = {
  key: 'home',
  name: 'Home & living',
  description: 'Furniture, decor, kitchen and bedding with dimensions and materials.',
  theme: 'hearth',
  lookups: [
    { code: 'room', name: 'Room', values: values('Living room', 'Bedroom', 'Kitchen', 'Dining', 'Bathroom', 'Outdoor', 'Office') },
    { code: 'material', name: 'Material', allowCustom: true, values: values('Solid wood', 'Engineered wood', 'Metal', 'Glass', 'Ceramic', 'Cotton', 'Linen', 'Rattan') },
    { code: 'style', name: 'Style', values: values('Modern', 'Minimal', 'Scandinavian', 'Industrial', 'Boho', 'Traditional') },
    { code: 'color', name: 'Colour', allowCustom: true, values: values('White', 'Black', 'Natural', 'Walnut', 'Grey', 'Green', 'Blue', 'Terracotta') },
  ],
  metafields: [
    { ownerType: 'product', key: 'dimensions', name: 'Dimensions (W × D × H)', type: 'single_line_text_field' },
    { ownerType: 'product', key: 'assembly_required', name: 'Assembly required', type: 'boolean', filterable: true },
    { ownerType: 'product', key: 'care_instructions', name: 'Care instructions', type: 'multi_line_text_field' },
    { ownerType: 'product', key: 'weight_capacity_kg', name: 'Weight capacity (kg)', type: 'number_integer' },
  ],
  categories: [
    category('Furniture', ['Sofas', 'Tables', 'Chairs', 'Storage', 'Beds']),
    category('Decor', ['Wall art', 'Mirrors', 'Vases', 'Candles', 'Plants']),
    category('Kitchen & dining', ['Cookware', 'Tableware', 'Glassware', 'Storage']),
    category('Bedding & bath', ['Bedsheets', 'Pillows', 'Towels']),
    category('Lighting'),
  ],
  collections: [...STANDARD_COLLECTIONS, { slug: 'room-edits', title: 'Shop by room', sortType: 'manual', showInMenu: true }],
  searchSynonyms: [
    { term: 'couch', synonyms: ['sofa', 'settee'] },
    { term: 'lamp', synonyms: ['light', 'lighting'] },
    { term: 'duvet', synonyms: ['quilt', 'comforter'] },
  ],
  hero: { heading: 'Make your house a home', body: 'Furniture and objects made to last, and to be lived with.', cta: 'Shop by room' },
  promises: [
    { icon: 'truck', title: 'White-glove delivery', body: 'Large items placed in the room you choose.' },
    { icon: 'check', title: 'Free assembly', body: 'On furniture, where it is needed.' },
    { icon: 'check', title: '30-day returns', body: 'Live with it before you decide.' },
  ],
};

const JEWELRY: VerticalBlueprint = {
  key: 'jewelry',
  name: 'Jewellery & watches',
  description: 'Fine and fashion jewellery with metals, stones and certification.',
  theme: 'gleam',
  lookups: [
    { code: 'metal', name: 'Metal', values: values('Gold', 'Rose gold', 'White gold', 'Silver', 'Platinum', 'Brass', 'Stainless steel') },
    { code: 'purity', name: 'Purity', values: values('24K', '22K', '18K', '14K', '925 Sterling') },
    { code: 'stone', name: 'Stone', allowCustom: true, values: values('Diamond', 'Ruby', 'Emerald', 'Sapphire', 'Pearl', 'Cubic zirconia', 'None') },
    { code: 'ring_size', name: 'Ring size', values: values('5', '6', '7', '8', '9', '10', '11', '12') },
    GENDER,
  ],
  metafields: [
    { ownerType: 'product', key: 'metal_weight_g', name: 'Metal weight (g)', type: 'number_decimal' },
    { ownerType: 'product', key: 'certificate', name: 'Certificate', type: 'file_reference' },
    { ownerType: 'product', key: 'hallmark', name: 'Hallmark / HUID', type: 'single_line_text_field' },
    { ownerType: 'product', key: 'care_instructions', name: 'Care instructions', type: 'multi_line_text_field' },
  ],
  categories: [
    category('Rings', ['Engagement', 'Bands', 'Statement']),
    category('Necklaces', ['Pendants', 'Chains', 'Chokers']),
    category('Earrings', ['Studs', 'Hoops', 'Drops']),
    category('Bracelets & bangles'),
    category('Watches'),
  ],
  collections: [...STANDARD_COLLECTIONS, { slug: 'bridal', title: 'Bridal', sortType: 'manual', showInMenu: true }],
  searchSynonyms: [
    { term: 'necklace', synonyms: ['chain', 'pendant'] },
    { term: 'earrings', synonyms: ['studs', 'jhumka'] },
  ],
  hero: { heading: 'Made to be kept', body: 'Certified metals and stones, finished by hand.', cta: 'Explore the collection' },
  promises: [
    { icon: 'star', title: 'Certified', body: 'Hallmarked and certified pieces.' },
    { icon: 'shield', title: 'Insured delivery', body: 'Fully insured, signature on delivery.' },
    { icon: 'star', title: 'Gift ready', body: 'Every piece arrives boxed.' },
  ],
};

const SPORTS: VerticalBlueprint = {
  key: 'sports',
  name: 'Sports & fitness',
  description: 'Equipment, activewear and nutrition by sport and level.',
  theme: 'stride',
  lookups: [
    { code: 'sport', name: 'Sport', allowCustom: true, values: values('Running', 'Gym', 'Yoga', 'Cycling', 'Football', 'Cricket', 'Tennis', 'Swimming', 'Hiking') },
    { code: 'size', name: 'Size', values: values('XS', 'S', 'M', 'L', 'XL', 'XXL') },
    { code: 'level', name: 'Level', values: values('Beginner', 'Intermediate', 'Advanced', 'Pro') },
    GENDER,
  ],
  metafields: [
    { ownerType: 'product', key: 'specifications', name: 'Specifications', type: 'json' },
    { ownerType: 'product', key: 'weight_capacity_kg', name: 'Max user weight (kg)', type: 'number_integer' },
    { ownerType: 'product', key: 'warranty_months', name: 'Warranty (months)', type: 'number_integer' },
  ],
  categories: [
    category('Activewear', ['Tops', 'Bottoms', 'Shoes']),
    category('Equipment', ['Weights', 'Mats', 'Cardio', 'Accessories']),
    category('Outdoor', ['Camping', 'Hiking', 'Cycling']),
    category('Team sports'),
    category('Nutrition'),
  ],
  collections: STANDARD_COLLECTIONS,
  searchSynonyms: [
    { term: 'dumbbell', synonyms: ['weights', 'dumbell'] },
    { term: 'mat', synonyms: ['yoga mat', 'exercise mat'] },
  ],
  hero: { heading: 'Gear for every goal', body: 'Tested by people who train.', cta: 'Shop by sport' },
  promises: [
    { icon: 'star', title: 'Performance tested', body: 'Chosen by athletes, not buyers.' },
    { icon: 'check', title: 'Try it out', body: '30 days to make sure it fits.' },
    { icon: 'truck', title: 'Fast delivery', body: 'Dispatched within two working days.' },
  ],
};

const BOOKS: VerticalBlueprint = {
  key: 'books',
  name: 'Books & stationery',
  description: 'Books by author, format and language, plus stationery.',
  theme: 'folio',
  lookups: [
    { code: 'format', name: 'Format', values: values('Paperback', 'Hardcover', 'eBook', 'Audiobook') },
    { code: 'language', name: 'Language', allowCustom: true, values: values('English', 'Hindi', 'Spanish', 'French', 'German') },
    { code: 'genre', name: 'Genre', allowCustom: true, values: values('Fiction', 'Non-fiction', 'Mystery', 'Science fiction', 'Biography', 'Children', 'Self-help', 'Business') },
  ],
  metafields: [
    { ownerType: 'product', key: 'author', name: 'Author', type: 'single_line_text_field', filterable: true },
    { ownerType: 'product', key: 'isbn', name: 'ISBN', type: 'single_line_text_field' },
    { ownerType: 'product', key: 'publisher', name: 'Publisher', type: 'single_line_text_field', filterable: true },
    { ownerType: 'product', key: 'pages', name: 'Pages', type: 'number_integer' },
    { ownerType: 'product', key: 'published_on', name: 'Publication date', type: 'date' },
  ],
  categories: [
    category('Fiction'),
    category('Non-fiction'),
    category("Children's books"),
    category('Academic'),
    category('Stationery', ['Notebooks', 'Pens', 'Art supplies']),
  ],
  collections: [...STANDARD_COLLECTIONS, { slug: 'staff-picks', title: 'Staff picks', sortType: 'manual', showInMenu: true }],
  searchSynonyms: [{ term: 'novel', synonyms: ['fiction', 'book'] }],
  hero: { heading: 'Find your next favourite book', body: 'Hand-picked reads and everything you need to write your own.', cta: 'Browse books' },
  promises: [
    { icon: 'star', title: 'Curated shelves', body: 'Every book chosen by a reader.' },
    { icon: 'truck', title: 'Careful packing', body: 'Corners arrive sharp.' },
    { icon: 'star', title: 'Gift wrapping', body: 'Add a note at checkout.' },
  ],
};

const PETS: VerticalBlueprint = {
  key: 'pets',
  name: 'Pet supplies',
  description: 'Food, toys and care by pet type, age and size.',
  theme: 'aurora',
  lookups: [
    { code: 'pet_type', name: 'Pet', values: values('Dog', 'Cat', 'Bird', 'Fish', 'Small animal') },
    { code: 'life_stage', name: 'Life stage', values: values('Puppy / kitten', 'Adult', 'Senior') },
    { code: 'breed_size', name: 'Breed size', values: values('Small', 'Medium', 'Large', 'Giant') },
  ],
  metafields: [
    { ownerType: 'product', key: 'ingredients', name: 'Ingredients', type: 'multi_line_text_field' },
    { ownerType: 'product', key: 'feeding_guide', name: 'Feeding guide', type: 'rich_text_field' },
  ],
  categories: [category('Dogs', ['Food', 'Treats', 'Toys', 'Beds']), category('Cats', ['Food', 'Litter', 'Toys']), category('Grooming'), category('Health')],
  collections: STANDARD_COLLECTIONS,
  searchSynonyms: [{ term: 'kibble', synonyms: ['dry food', 'dog food'] }],
  hero: { heading: 'Everything for the ones who wait at the door', body: 'Food, toys and care they will love.', cta: 'Shop for your pet' },
  promises: [
    { icon: 'check', title: 'Vet approved', body: 'Nutrition checked by vets.' },
    { icon: 'star', title: 'Subscribe & save', body: 'Never run out of food.' },
    { icon: 'truck', title: 'Fast delivery', body: 'Heavy bags to your door.' },
  ],
};

const TOYS: VerticalBlueprint = {
  key: 'toys',
  name: 'Toys, kids & baby',
  description: 'Toys and baby products by age, safety and skills.',
  theme: 'aurora',
  lookups: [
    { code: 'age_group', name: 'Age', values: values('0-12 months', '1-2 years', '3-5 years', '6-8 years', '9-12 years', '12+ years') },
    { code: 'skill', name: 'Develops', values: values('Motor skills', 'Creativity', 'Problem solving', 'Language', 'STEM') },
    GENDER,
  ],
  metafields: [
    { ownerType: 'product', key: 'safety_standard', name: 'Safety standard', type: 'single_line_text_field' },
    { ownerType: 'product', key: 'batteries_required', name: 'Batteries required', type: 'boolean', filterable: true },
    { ownerType: 'product', key: 'choking_hazard', name: 'Small parts warning', type: 'boolean' },
  ],
  categories: [category('Toys', ['Educational', 'Outdoor', 'Puzzles', 'Soft toys']), category('Baby', ['Feeding', 'Bath', 'Clothing']), category('Books & games')],
  collections: STANDARD_COLLECTIONS,
  searchSynonyms: [{ term: 'lego', synonyms: ['building blocks', 'blocks'] }],
  hero: { heading: 'Play that grows with them', body: 'Safe, thoughtful toys for every age.', cta: 'Shop by age' },
  promises: [
    { icon: 'shield', title: 'Safety tested', body: 'Certified to recognised standards.' },
    { icon: 'star', title: 'Gift wrapping', body: 'Ready to give.' },
    { icon: 'check', title: 'Easy returns', body: 'Unopened within 30 days.' },
  ],
};

const HEALTH: VerticalBlueprint = {
  key: 'health',
  name: 'Health & wellness',
  description: 'Supplements, wellness and personal care with dosage and certifications.',
  theme: 'lumen',
  lookups: [
    { code: 'form', name: 'Form', values: values('Capsule', 'Tablet', 'Powder', 'Gummy', 'Liquid') },
    { code: 'goal', name: 'Goal', allowCustom: true, values: values('Immunity', 'Energy', 'Sleep', 'Digestion', 'Muscle', 'Weight', 'Skin & hair') },
    { code: 'diet', name: 'Diet', values: values('Vegetarian', 'Vegan', 'Gluten free', 'Sugar free') },
  ],
  metafields: [
    { ownerType: 'product', key: 'dosage', name: 'Dosage', type: 'single_line_text_field' },
    { ownerType: 'product', key: 'ingredients', name: 'Ingredients', type: 'multi_line_text_field' },
    { ownerType: 'product', key: 'servings', name: 'Servings per pack', type: 'number_integer' },
    { ownerType: 'product', key: 'disclaimer', name: 'Disclaimer', type: 'multi_line_text_field' },
  ],
  categories: [category('Vitamins & supplements'), category('Sports nutrition'), category('Personal care'), category('Wellness devices')],
  collections: STANDARD_COLLECTIONS,
  searchSynonyms: [{ term: 'multivitamin', synonyms: ['vitamins', 'multi vitamin'] }],
  hero: { heading: 'Wellness you can check', body: 'Every ingredient and dose, printed plainly.', cta: 'Shop by goal' },
  promises: [
    { icon: 'flask', title: 'Lab tested', body: 'Third-party tested batches.' },
    { icon: 'leaf', title: 'Clean labels', body: 'No hidden fillers.' },
    { icon: 'truck', title: 'Fast delivery', body: 'Dispatched within a day.' },
  ],
};

const VERTICALS: VerticalBlueprint[] = [GENERAL, FASHION, BEAUTY, ELECTRONICS, GROCERY, HOME, JEWELRY, SPORTS, BOOKS, PETS, TOYS, HEALTH];

export function verticalFor(key: string): VerticalBlueprint {
  return VERTICALS.find((vertical) => vertical.key === key) ?? GENERAL;
}

export function verticalCatalog() {
  return VERTICALS.map((vertical) => ({
    key: vertical.key,
    name: vertical.name,
    description: vertical.description,
    theme: vertical.theme,
  }));
}

export const VERTICAL_KEYS = VERTICALS.map((vertical) => vertical.key);
