-- ============================================================================
-- LOOKUP TABLES SYSTEM
-- Generic dropdown/select options management
-- ============================================================================

-- Lookup Categories (Dropdown Types)
CREATE TABLE lookup_categories (
  id BIGINT UNSIGNED PRIMARY KEY AUTO_INCREMENT,
  code VARCHAR(100) NOT NULL UNIQUE COMMENT 'Unique identifier: benefits, skin_types, etc',
  name VARCHAR(191) NOT NULL COMMENT 'Display name for admin UI',
  description TEXT NULL COMMENT 'What this lookup is for',
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  allow_custom BOOLEAN NOT NULL DEFAULT FALSE COMMENT 'Allow users to add custom values',
  sort_order SMALLINT UNSIGNED NOT NULL DEFAULT 0,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  
  INDEX idx_code (code),
  INDEX idx_active (is_active)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Lookup Values (Dropdown Options)
CREATE TABLE lookup_values (
  id BIGINT UNSIGNED PRIMARY KEY AUTO_INCREMENT,
  category_id BIGINT UNSIGNED NOT NULL,
  code VARCHAR(100) NOT NULL COMMENT 'Unique value identifier within category',
  label VARCHAR(191) NOT NULL COMMENT 'Display text',
  description TEXT NULL COMMENT 'Helper text or tooltip',
  icon VARCHAR(191) NULL COMMENT 'Icon name or URL',
  color VARCHAR(20) NULL COMMENT 'Badge/chip color',
  metadata JSON NULL COMMENT 'Additional attributes',
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  sort_order SMALLINT UNSIGNED NOT NULL DEFAULT 0,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  
  FOREIGN KEY (category_id) REFERENCES lookup_categories(id) ON DELETE CASCADE,
  UNIQUE KEY uniq_category_code (category_id, code),
  INDEX idx_category_active (category_id, is_active),
  INDEX idx_sort (category_id, sort_order)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ============================================================================
-- SEED DATA - Cosmetic Product Dropdowns
-- ============================================================================

-- Insert Categories
INSERT INTO lookup_categories (code, name, description, allow_custom, sort_order) VALUES
('benefits', 'Product Benefits', 'Cosmetic product benefits/claims', TRUE, 1),
('skin_types', 'Skin Types', 'Suitable skin types', FALSE, 2),
('skin_concerns', 'Skin Concerns', 'Addressed skin concerns', TRUE, 3),
('finish', 'Product Finish', 'Surface finish appearance', FALSE, 4),
('coverage', 'Coverage Level', 'Makeup coverage intensity', FALSE, 5),
('shade_family', 'Shade Family', 'Color undertones', FALSE, 6),
('formulation_type', 'Formulation Type', 'Physical product form', TRUE, 7),
('absorption_rate', 'Absorption Rate', 'How quickly product absorbs', FALSE, 8),
('pregnancy_safe', 'Pregnancy Safety', 'Pregnancy safety status', FALSE, 9),
('gender_target', 'Gender Target', 'Target gender demographic', FALSE, 10),
('season', 'Season', 'Seasonal availability', FALSE, 11),
('free_from', 'Free From', 'Excluded ingredients', TRUE, 12),
('claims', 'Product Claims', 'Marketing/clinical claims', TRUE, 13),
('certification_type', 'Certification Types', 'Available certifications', TRUE, 14),
('packaging_type', 'Packaging Types', 'Package formats', TRUE, 15),
('application_method', 'Application Methods', 'How to apply product', TRUE, 16),
('age_range', 'Age Ranges', 'Target age demographics', FALSE, 17);

-- Benefits
INSERT INTO lookup_values (category_id, code, label, description, sort_order) VALUES
((SELECT id FROM lookup_categories WHERE code = 'benefits'), 'hydrating', 'Hydrating', 'Provides moisture and hydration', 1),
((SELECT id FROM lookup_categories WHERE code = 'benefits'), 'anti_aging', 'Anti-Aging', 'Reduces signs of aging', 2),
((SELECT id FROM lookup_categories WHERE code = 'benefits'), 'brightening', 'Brightening', 'Evens skin tone and adds radiance', 3),
((SELECT id FROM lookup_categories WHERE code = 'benefits'), 'plumping', 'Plumping', 'Adds volume and fullness', 4),
((SELECT id FROM lookup_categories WHERE code = 'benefits'), 'firming', 'Firming', 'Improves skin firmness', 5),
((SELECT id FROM lookup_categories WHERE code = 'benefits'), 'smoothing', 'Smoothing', 'Refines texture', 6),
((SELECT id FROM lookup_categories WHERE code = 'benefits'), 'nourishing', 'Nourishing', 'Feeds skin with nutrients', 7),
((SELECT id FROM lookup_categories WHERE code = 'benefits'), 'soothing', 'Soothing', 'Calms and comforts skin', 8),
((SELECT id FROM lookup_categories WHERE code = 'benefits'), 'protecting', 'Protecting', 'Shields from environmental damage', 9),
((SELECT id FROM lookup_categories WHERE code = 'benefits'), 'exfoliating', 'Exfoliating', 'Removes dead skin cells', 10),
((SELECT id FROM lookup_categories WHERE code = 'benefits'), 'mattifying', 'Mattifying', 'Controls oil and shine', 11),
((SELECT id FROM lookup_categories WHERE code = 'benefits'), 'pore_minimizing', 'Pore Minimizing', 'Reduces appearance of pores', 12),
((SELECT id FROM lookup_categories WHERE code = 'benefits'), 'acne_fighting', 'Acne Fighting', 'Treats and prevents acne', 13),
((SELECT id FROM lookup_categories WHERE code = 'benefits'), 'oil_control', 'Oil Control', 'Regulates sebum production', 14),
((SELECT id FROM lookup_categories WHERE code = 'benefits'), 'long_wearing', 'Long-Wearing', 'Extended wear time', 15);

-- Skin Types
INSERT INTO lookup_values (category_id, code, label, description, color, sort_order) VALUES
((SELECT id FROM lookup_categories WHERE code = 'skin_types'), 'dry', 'Dry', 'Lacks moisture, feels tight', '#E3F2FD', 1),
((SELECT id FROM lookup_categories WHERE code = 'skin_types'), 'oily', 'Oily', 'Excess sebum, shiny appearance', '#FFF9C4', 2),
((SELECT id FROM lookup_categories WHERE code = 'skin_types'), 'combination', 'Combination', 'Oily T-zone, dry cheeks', '#E1BEE7', 3),
((SELECT id FROM lookup_categories WHERE code = 'skin_types'), 'normal', 'Normal', 'Balanced, not too dry or oily', '#C8E6C9', 4),
((SELECT id FROM lookup_categories WHERE code = 'skin_types'), 'sensitive', 'Sensitive', 'Easily irritated, reactive', '#FFCCBC', 5),
((SELECT id FROM lookup_categories WHERE code = 'skin_types'), 'mature', 'Mature', 'Aging skin with fine lines', '#D7CCC8', 6);

-- Skin Concerns
INSERT INTO lookup_values (category_id, code, label, description, sort_order) VALUES
((SELECT id FROM lookup_categories WHERE code = 'skin_concerns'), 'fine_lines', 'Fine Lines & Wrinkles', 'Signs of aging', 1),
((SELECT id FROM lookup_categories WHERE code = 'skin_concerns'), 'dark_spots', 'Dark Spots', 'Hyperpigmentation', 2),
((SELECT id FROM lookup_categories WHERE code = 'skin_concerns'), 'dullness', 'Dullness', 'Lack of radiance', 3),
((SELECT id FROM lookup_categories WHERE code = 'skin_concerns'), 'uneven_tone', 'Uneven Skin Tone', 'Color irregularities', 4),
((SELECT id FROM lookup_categories WHERE code = 'skin_concerns'), 'acne', 'Acne', 'Breakouts and blemishes', 5),
((SELECT id FROM lookup_categories WHERE code = 'skin_concerns'), 'large_pores', 'Large Pores', 'Visible pores', 6),
((SELECT id FROM lookup_categories WHERE code = 'skin_concerns'), 'redness', 'Redness', 'Inflammation and rosacea', 7),
((SELECT id FROM lookup_categories WHERE code = 'skin_concerns'), 'dehydration', 'Dehydration', 'Lack of water in skin', 8),
((SELECT id FROM lookup_categories WHERE code = 'skin_concerns'), 'texture', 'Rough Texture', 'Uneven surface', 9),
((SELECT id FROM lookup_categories WHERE code = 'skin_concerns'), 'loss_firmness', 'Loss of Firmness', 'Sagging skin', 10),
((SELECT id FROM lookup_categories WHERE code = 'skin_concerns'), 'dark_circles', 'Dark Circles', 'Under-eye darkness', 11),
((SELECT id FROM lookup_categories WHERE code = 'skin_concerns'), 'sensitivity', 'Sensitivity', 'Easily irritated', 12);

-- Finish
INSERT INTO lookup_values (category_id, code, label, description, sort_order) VALUES
((SELECT id FROM lookup_categories WHERE code = 'finish'), 'matte', 'Matte', 'No shine, flat finish', 1),
((SELECT id FROM lookup_categories WHERE code = 'finish'), 'dewy', 'Dewy', 'Luminous, glowing finish', 2),
((SELECT id FROM lookup_categories WHERE code = 'finish'), 'natural', 'Natural', 'Skin-like, subtle finish', 3),
((SELECT id FROM lookup_categories WHERE code = 'finish'), 'satin', 'Satin', 'Soft sheen, semi-matte', 4),
((SELECT id FROM lookup_categories WHERE code = 'finish'), 'radiant', 'Radiant', 'Bright, luminous glow', 5),
((SELECT id FROM lookup_categories WHERE code = 'finish'), 'luminous', 'Luminous', 'Light-reflecting finish', 6),
((SELECT id FROM lookup_categories WHERE code = 'finish'), 'glossy', 'Glossy', 'High shine finish', 7),
((SELECT id FROM lookup_categories WHERE code = 'finish'), 'shimmer', 'Shimmer', 'Sparkle and shine', 8);

-- Coverage
INSERT INTO lookup_values (category_id, code, label, description, sort_order) VALUES
((SELECT id FROM lookup_categories WHERE code = 'coverage'), 'sheer', 'Sheer', 'Light, translucent coverage', 1),
((SELECT id FROM lookup_categories WHERE code = 'coverage'), 'light', 'Light', 'Minimal, natural coverage', 2),
((SELECT id FROM lookup_categories WHERE code = 'coverage'), 'medium', 'Medium', 'Moderate, buildable coverage', 3),
((SELECT id FROM lookup_categories WHERE code = 'coverage'), 'full', 'Full', 'Complete, opaque coverage', 4),
((SELECT id FROM lookup_categories WHERE code = 'coverage'), 'buildable', 'Buildable', 'Adjustable coverage level', 5);

-- Shade Family
INSERT INTO lookup_values (category_id, code, label, description, sort_order) VALUES
((SELECT id FROM lookup_categories WHERE code = 'shade_family'), 'warm', 'Warm', 'Yellow, golden undertones', 1),
((SELECT id FROM lookup_categories WHERE code = 'shade_family'), 'cool', 'Cool', 'Pink, blue undertones', 2),
((SELECT id FROM lookup_categories WHERE code = 'shade_family'), 'neutral', 'Neutral', 'Balanced undertones', 3),
((SELECT id FROM lookup_categories WHERE code = 'shade_family'), 'olive', 'Olive', 'Green undertones', 4);

-- Formulation Type
INSERT INTO lookup_values (category_id, code, label, description, sort_order) VALUES
((SELECT id FROM lookup_categories WHERE code = 'formulation_type'), 'cream', 'Cream', 'Rich, emollient texture', 1),
((SELECT id FROM lookup_categories WHERE code = 'formulation_type'), 'gel', 'Gel', 'Lightweight, water-based', 2),
((SELECT id FROM lookup_categories WHERE code = 'formulation_type'), 'serum', 'Serum', 'Concentrated, lightweight', 3),
((SELECT id FROM lookup_categories WHERE code = 'formulation_type'), 'oil', 'Oil', 'Lipid-based formula', 4),
((SELECT id FROM lookup_categories WHERE code = 'formulation_type'), 'lotion', 'Lotion', 'Light, fluid texture', 5),
((SELECT id FROM lookup_categories WHERE code = 'formulation_type'), 'balm', 'Balm', 'Solid, waxy texture', 6),
((SELECT id FROM lookup_categories WHERE code = 'formulation_type'), 'foam', 'Foam', 'Airy, whipped texture', 7),
((SELECT id FROM lookup_categories WHERE code = 'formulation_type'), 'powder', 'Powder', 'Dry, loose or pressed', 8),
((SELECT id FROM lookup_categories WHERE code = 'formulation_type'), 'liquid', 'Liquid', 'Thin, pourable', 9),
((SELECT id FROM lookup_categories WHERE code = 'formulation_type'), 'mousse', 'Mousse', 'Whipped, airy texture', 10);

-- Absorption Rate
INSERT INTO lookup_values (category_id, code, label, description, sort_order) VALUES
((SELECT id FROM lookup_categories WHERE code = 'absorption_rate'), 'instant', 'Instant', 'Absorbs immediately', 1),
((SELECT id FROM lookup_categories WHERE code = 'absorption_rate'), 'fast', 'Fast', 'Absorbs in 1-2 minutes', 2),
((SELECT id FROM lookup_categories WHERE code = 'absorption_rate'), 'medium', 'Medium', 'Absorbs in 3-5 minutes', 3),
((SELECT id FROM lookup_categories WHERE code = 'absorption_rate'), 'slow', 'Slow', 'Takes 5+ minutes to absorb', 4);

-- Pregnancy Safety
INSERT INTO lookup_values (category_id, code, label, description, color, sort_order) VALUES
((SELECT id FROM lookup_categories WHERE code = 'pregnancy_safe'), 'safe', 'Safe', 'Safe for use during pregnancy', '#C8E6C9', 1),
((SELECT id FROM lookup_categories WHERE code = 'pregnancy_safe'), 'consult_doctor', 'Consult Doctor', 'Check with healthcare provider', '#FFF9C4', 2),
((SELECT id FROM lookup_categories WHERE code = 'pregnancy_safe'), 'not_recommended', 'Not Recommended', 'Avoid during pregnancy', '#FFCDD2', 3);

-- Gender Target
INSERT INTO lookup_values (category_id, code, label, sort_order) VALUES
((SELECT id FROM lookup_categories WHERE code = 'gender_target'), 'unisex', 'Unisex', 1),
((SELECT id FROM lookup_categories WHERE code = 'gender_target'), 'female', 'Female', 2),
((SELECT id FROM lookup_categories WHERE code = 'gender_target'), 'male', 'Male', 3),
((SELECT id FROM lookup_categories WHERE code = 'gender_target'), 'non_binary', 'Non-Binary', 4);

-- Season
INSERT INTO lookup_values (category_id, code, label, sort_order) VALUES
((SELECT id FROM lookup_categories WHERE code = 'season'), 'spring', 'Spring', 1),
((SELECT id FROM lookup_categories WHERE code = 'season'), 'summer', 'Summer', 2),
((SELECT id FROM lookup_categories WHERE code = 'season'), 'fall', 'Fall', 3),
((SELECT id FROM lookup_categories WHERE code = 'season'), 'winter', 'Winter', 4),
((SELECT id FROM lookup_categories WHERE code = 'season'), 'all_year', 'All Year', 5);

-- Free From (Common exclusions)
INSERT INTO lookup_values (category_id, code, label, sort_order) VALUES
((SELECT id FROM lookup_categories WHERE code = 'free_from'), 'parabens', 'Parabens', 1),
((SELECT id FROM lookup_categories WHERE code = 'free_from'), 'sulfates', 'Sulfates', 2),
((SELECT id FROM lookup_categories WHERE code = 'free_from'), 'phthalates', 'Phthalates', 3),
((SELECT id FROM lookup_categories WHERE code = 'free_from'), 'mineral_oil', 'Mineral Oil', 4),
((SELECT id FROM lookup_categories WHERE code = 'free_from'), 'fragrance', 'Fragrance', 5),
((SELECT id FROM lookup_categories WHERE code = 'free_from'), 'silicones', 'Silicones', 6),
((SELECT id FROM lookup_categories WHERE code = 'free_from'), 'alcohol', 'Alcohol', 7),
((SELECT id FROM lookup_categories WHERE code = 'free_from'), 'artificial_colors', 'Artificial Colors', 8),
((SELECT id FROM lookup_categories WHERE code = 'free_from'), 'talc', 'Talc', 9),
((SELECT id FROM lookup_categories WHERE code = 'free_from'), 'formaldehyde', 'Formaldehyde', 10);

-- Claims
INSERT INTO lookup_values (category_id, code, label, sort_order) VALUES
((SELECT id FROM lookup_categories WHERE code = 'claims'), 'dermatologist_tested', 'Dermatologist Tested', 1),
((SELECT id FROM lookup_categories WHERE code = 'claims'), 'clinically_proven', 'Clinically Proven', 2),
((SELECT id FROM lookup_categories WHERE code = 'claims'), 'allergy_tested', 'Allergy Tested', 3),
((SELECT id FROM lookup_categories WHERE code = 'claims'), 'ophthalmologist_tested', 'Ophthalmologist Tested', 4),
((SELECT id FROM lookup_categories WHERE code = 'claims'), 'non_irritating', 'Non-Irritating', 5),
((SELECT id FROM lookup_categories WHERE code = 'claims'), 'fragrance_free', 'Fragrance Free', 6),
((SELECT id FROM lookup_categories WHERE code = 'claims'), 'oil_free', 'Oil Free', 7),
((SELECT id FROM lookup_categories WHERE code = 'claims'), 'water_resistant', 'Water Resistant', 8),
((SELECT id FROM lookup_categories WHERE code = 'claims'), 'long_lasting', 'Long Lasting', 9);

-- Certification Types
INSERT INTO lookup_values (category_id, code, label, description, sort_order) VALUES
((SELECT id FROM lookup_categories WHERE code = 'certification_type'), 'cruelty_free', 'Cruelty-Free', 'Not tested on animals', 1),
((SELECT id FROM lookup_categories WHERE code = 'certification_type'), 'vegan', 'Vegan', 'No animal-derived ingredients', 2),
((SELECT id FROM lookup_categories WHERE code = 'certification_type'), 'organic', 'Organic', 'Certified organic ingredients', 3),
((SELECT id FROM lookup_categories WHERE code = 'certification_type'), 'natural', 'Natural', 'Natural ingredients certified', 4),
((SELECT id FROM lookup_categories WHERE code = 'certification_type'), 'halal', 'Halal', 'Halal certified', 5),
((SELECT id FROM lookup_categories WHERE code = 'certification_type'), 'kosher', 'Kosher', 'Kosher certified', 6),
((SELECT id FROM lookup_categories WHERE code = 'certification_type'), 'ecocert', 'Ecocert', 'Ecocert organic standard', 7),
((SELECT id FROM lookup_categories WHERE code = 'certification_type'), 'usda_organic', 'USDA Organic', 'USDA organic certification', 8);

-- Packaging Types
INSERT INTO lookup_values (category_id, code, label, sort_order) VALUES
((SELECT id FROM lookup_categories WHERE code = 'packaging_type'), 'pump_bottle', 'Pump Bottle', 1),
((SELECT id FROM lookup_categories WHERE code = 'packaging_type'), 'dropper_bottle', 'Dropper Bottle', 2),
((SELECT id FROM lookup_categories WHERE code = 'packaging_type'), 'jar', 'Jar', 3),
((SELECT id FROM lookup_categories WHERE code = 'packaging_type'), 'tube', 'Tube', 4),
((SELECT id FROM lookup_categories WHERE code = 'packaging_type'), 'spray_bottle', 'Spray Bottle', 5),
((SELECT id FROM lookup_categories WHERE code = 'packaging_type'), 'stick', 'Stick', 6),
((SELECT id FROM lookup_categories WHERE code = 'packaging_type'), 'compact', 'Compact', 7),
((SELECT id FROM lookup_categories WHERE code = 'packaging_type'), 'pen', 'Pen', 8),
((SELECT id FROM lookup_categories WHERE code = 'packaging_type'), 'sachet', 'Sachet', 9),
((SELECT id FROM lookup_categories WHERE code = 'packaging_type'), 'ampoule', 'Ampoule', 10);

-- Application Methods
INSERT INTO lookup_values (category_id, code, label, sort_order) VALUES
((SELECT id FROM lookup_categories WHERE code = 'application_method'), 'fingertips', 'Fingertips', 1),
((SELECT id FROM lookup_categories WHERE code = 'application_method'), 'palms', 'Palms', 2),
((SELECT id FROM lookup_categories WHERE code = 'application_method'), 'cotton_pad', 'Cotton Pad', 3),
((SELECT id FROM lookup_categories WHERE code = 'application_method'), 'brush', 'Brush', 4),
((SELECT id FROM lookup_categories WHERE code = 'application_method'), 'sponge', 'Sponge', 5),
((SELECT id FROM lookup_categories WHERE code = 'application_method'), 'applicator', 'Applicator', 6),
((SELECT id FROM lookup_categories WHERE code = 'application_method'), 'roller', 'Roller', 7),
((SELECT id FROM lookup_categories WHERE code = 'application_method'), 'spray', 'Spray', 8);

-- Age Ranges
INSERT INTO lookup_values (category_id, code, label, sort_order) VALUES
((SELECT id FROM lookup_categories WHERE code = 'age_range'), 'all_ages', 'All Ages', 1),
((SELECT id FROM lookup_categories WHERE code = 'age_range'), '18_24', '18-24', 2),
((SELECT id FROM lookup_categories WHERE code = 'age_range'), '25_35', '25-35', 3),
((SELECT id FROM lookup_categories WHERE code = 'age_range'), '35_45', '35-45', 4),
((SELECT id FROM lookup_categories WHERE code = 'age_range'), '45_plus', '45+', 5),
((SELECT id FROM lookup_categories WHERE code = 'age_range'), '55_plus', '55+', 6);

-- ============================================================================
-- AUDIT TRAIL (Optional but recommended)
-- ============================================================================

CREATE TABLE lookup_value_audit (
  id BIGINT UNSIGNED PRIMARY KEY AUTO_INCREMENT,
  lookup_value_id BIGINT UNSIGNED NOT NULL,
  action ENUM('created', 'updated', 'deleted', 'activated', 'deactivated') NOT NULL,
  old_data JSON NULL,
  new_data JSON NULL,
  admin_user_id BIGINT UNSIGNED NULL,
  admin_name VARCHAR(191) NULL,
  ip_address VARCHAR(45) NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  
  INDEX idx_lookup_value (lookup_value_id),
  INDEX idx_created_at (created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
