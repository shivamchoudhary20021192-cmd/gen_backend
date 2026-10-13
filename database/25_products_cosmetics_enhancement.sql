-- ══════════════════════════════════════════════════════════════════════════════
-- COSMETICS PRODUCT ENHANCEMENTS
-- Add industry-grade fields for professional cosmetic product management
-- ══════════════════════════════════════════════════════════════════════════════

-- ── PRODUCT ATTRIBUTES (Benefits, Skin Type, Finish, etc.) ───────────────────

-- Benefits (e.g., "Hydrating", "Anti-Aging", "Brightening")
ALTER TABLE products 
ADD COLUMN benefits JSON NULL COMMENT 'Array of benefit tags' AFTER suitability_note;

-- Skin Types (e.g., "Dry", "Oily", "Combination", "Sensitive")
ALTER TABLE products 
ADD COLUMN skin_types JSON NULL COMMENT 'Array of suitable skin types' AFTER benefits;

-- Skin Concerns (e.g., "Acne", "Dark Spots", "Fine Lines")
ALTER TABLE products 
ADD COLUMN skin_concerns JSON NULL COMMENT 'Array of addressed skin concerns' AFTER skin_types;

-- Finish (e.g., "Matte", "Dewy", "Satin", "Natural")
ALTER TABLE products 
ADD COLUMN finish VARCHAR(50) NULL COMMENT 'Product finish type' AFTER skin_concerns;

-- Coverage (for makeup products)
ALTER TABLE products 
ADD COLUMN coverage ENUM('sheer', 'light', 'medium', 'full', 'buildable') NULL COMMENT 'Coverage level for makeup' AFTER finish;

-- Shade/Color (for color cosmetics)
ALTER TABLE products 
ADD COLUMN shade_family VARCHAR(100) NULL COMMENT 'Color family (e.g., Warm, Cool, Neutral)' AFTER coverage;

-- ── FORMULATION DETAILS ──────────────────────────────────────────────────────

-- Key Ingredients (highlighted active ingredients)
ALTER TABLE products 
ADD COLUMN key_ingredients JSON NULL COMMENT 'Array of key active ingredients with percentages' AFTER full_inci;

-- Ingredient Highlights (marketing-friendly ingredient names)
ALTER TABLE products 
ADD COLUMN ingredient_highlights VARCHAR(500) NULL COMMENT 'Marketing description of key ingredients' AFTER key_ingredients;

-- Free From (e.g., "Paraben-Free", "Sulfate-Free")
ALTER TABLE products 
ADD COLUMN free_from JSON NULL COMMENT 'Array of excluded ingredients/categories' AFTER ingredient_highlights;

-- Formulation Type (e.g., "Cream", "Gel", "Serum", "Oil")
ALTER TABLE products 
ADD COLUMN formulation_type VARCHAR(80) NULL COMMENT 'Physical form of product' AFTER free_from;

-- pH Level
ALTER TABLE products 
ADD COLUMN ph_level VARCHAR(20) NULL COMMENT 'pH range (e.g., 5.0-6.0)' AFTER formulation_type;

-- ── CERTIFICATIONS & CLAIMS ──────────────────────────────────────────────────

-- Certifications (e.g., "Organic", "Cruelty-Free", "Vegan")
ALTER TABLE products 
ADD COLUMN certifications JSON NULL COMMENT 'Array of product certifications' AFTER ph_level;

-- Claims (e.g., "Dermatologist Tested", "Clinically Proven")
ALTER TABLE products 
ADD COLUMN claims JSON NULL COMMENT 'Array of product claims' AFTER certifications;

-- Hypoallergenic
ALTER TABLE products 
ADD COLUMN is_hypoallergenic BOOLEAN NOT NULL DEFAULT FALSE COMMENT 'Hypoallergenic formulation' AFTER claims;

-- Non-Comedogenic
ALTER TABLE products 
ADD COLUMN is_non_comedogenic BOOLEAN NOT NULL DEFAULT FALSE COMMENT 'Non-pore-clogging' AFTER is_hypoallergenic;

-- Pregnancy Safe
ALTER TABLE products 
ADD COLUMN pregnancy_safe ENUM('safe', 'consult_doctor', 'not_recommended') NULL COMMENT 'Safety during pregnancy' AFTER is_non_comedogenic;

-- ── USAGE INSTRUCTIONS ───────────────────────────────────────────────────────

-- How to Use (detailed instructions)
ALTER TABLE products 
ADD COLUMN usage_instructions TEXT NULL COMMENT 'Step-by-step usage guide' AFTER storage_instructions;

-- Application Method (e.g., "Fingertips", "Cotton Pad", "Brush")
ALTER TABLE products 
ADD COLUMN application_method VARCHAR(255) NULL COMMENT 'Recommended application tools/methods' AFTER usage_instructions;

-- Frequency (e.g., "Daily", "Twice Daily", "Weekly")
ALTER TABLE products 
ADD COLUMN usage_frequency VARCHAR(100) NULL COMMENT 'Recommended frequency of use' AFTER application_method;

-- Best Used With (complementary products)
ALTER TABLE products 
ADD COLUMN best_used_with JSON NULL COMMENT 'Array of complementary product IDs' AFTER usage_frequency;

-- ── PERFORMANCE & EFFICACY ───────────────────────────────────────────────────

-- Results Timeline (e.g., "Immediate", "2 weeks", "4-6 weeks")
ALTER TABLE products 
ADD COLUMN results_timeline VARCHAR(150) NULL COMMENT 'Expected time to see results' AFTER best_used_with;

-- Clinical Study Info
ALTER TABLE products 
ADD COLUMN clinical_study_summary TEXT NULL COMMENT 'Summary of clinical studies/trials' AFTER results_timeline;

-- Before/After Study
ALTER TABLE products 
ADD COLUMN has_before_after_study BOOLEAN NOT NULL DEFAULT FALSE COMMENT 'Has before/after imagery' AFTER clinical_study_summary;

-- ── SENSORY ATTRIBUTES ────────────────────────────────────────────────────────

-- Texture Details (more descriptive than existing texture field)
ALTER TABLE products 
ADD COLUMN texture_description VARCHAR(500) NULL COMMENT 'Detailed texture description' AFTER has_before_after_study;

-- Color Description
ALTER TABLE products 
ADD COLUMN color_description VARCHAR(255) NULL COMMENT 'Visual appearance description' AFTER texture_description;

-- Absorption Rate (e.g., "Fast", "Medium", "Slow")
ALTER TABLE products 
ADD COLUMN absorption_rate ENUM('instant', 'fast', 'medium', 'slow') NULL COMMENT 'How quickly product absorbs' AFTER color_description;

-- Feel on Skin
ALTER TABLE products 
ADD COLUMN feel_on_skin VARCHAR(255) NULL COMMENT 'Sensory experience (e.g., lightweight, rich)' AFTER absorption_rate;

-- ── PACKAGING & SUSTAINABILITY ────────────────────────────────────────────────

-- Packaging Type (e.g., "Tube", "Jar", "Pump Bottle")
ALTER TABLE products 
ADD COLUMN packaging_type VARCHAR(100) NULL COMMENT 'Primary packaging format' AFTER feel_on_skin;

-- Packaging Material (e.g., "Glass", "PCR Plastic", "Aluminum")
ALTER TABLE products 
ADD COLUMN packaging_material VARCHAR(255) NULL COMMENT 'Packaging materials used' AFTER packaging_type;

-- Recyclable
ALTER TABLE products 
ADD COLUMN is_recyclable BOOLEAN NOT NULL DEFAULT FALSE COMMENT 'Packaging is recyclable' AFTER packaging_material;

-- Refillable
ALTER TABLE products 
ADD COLUMN is_refillable BOOLEAN NOT NULL DEFAULT FALSE COMMENT 'Product has refill option' AFTER is_recyclable;

-- Eco-Friendly
ALTER TABLE products 
ADD COLUMN is_eco_friendly BOOLEAN NOT NULL DEFAULT FALSE COMMENT 'Environmentally friendly product' AFTER is_refillable;

-- Carbon Neutral
ALTER TABLE products 
ADD COLUMN is_carbon_neutral BOOLEAN NOT NULL DEFAULT FALSE COMMENT 'Carbon neutral production/shipping' AFTER is_eco_friendly;

-- ── SIZE & VOLUME INFORMATION ─────────────────────────────────────────────────

-- Size Category (e.g., "Travel Size", "Full Size", "Deluxe Sample")
ALTER TABLE products 
ADD COLUMN size_category ENUM('sample', 'travel', 'standard', 'deluxe', 'professional', 'value') NULL COMMENT 'Size classification' AFTER is_carbon_neutral;

-- ── PROFESSIONAL USE ──────────────────────────────────────────────────────────

-- Professional Use
ALTER TABLE products 
ADD COLUMN is_professional_use BOOLEAN NOT NULL DEFAULT FALSE COMMENT 'For professional/salon use only' AFTER size_category;

-- Requires Training
ALTER TABLE products 
ADD COLUMN requires_training BOOLEAN NOT NULL DEFAULT FALSE COMMENT 'Requires professional training' AFTER is_professional_use;

-- ── GEOGRAPHICAL & REGULATORY ─────────────────────────────────────────────────

-- Regulatory Approvals (JSON array of countries/regions)
ALTER TABLE products 
ADD COLUMN regulatory_approvals JSON NULL COMMENT 'Countries/regions where approved' AFTER requires_training;

-- Restricted Regions
ALTER TABLE products 
ADD COLUMN restricted_regions JSON NULL COMMENT 'Countries/regions where restricted' AFTER regulatory_approvals;

-- ── AWARDS & RECOGNITION ──────────────────────────────────────────────────────

-- Awards
ALTER TABLE products 
ADD COLUMN awards JSON NULL COMMENT 'Array of awards received' AFTER restricted_regions;

-- Press Features
ALTER TABLE products 
ADD COLUMN press_features JSON NULL COMMENT 'Array of press mentions' AFTER awards;

-- ── TARGET DEMOGRAPHICS ───────────────────────────────────────────────────────

-- Age Range
ALTER TABLE products 
ADD COLUMN age_range VARCHAR(50) NULL COMMENT 'Target age range (e.g., 25-35, 40+)' AFTER press_features;

-- Gender Target
ALTER TABLE products 
ADD COLUMN gender_target ENUM('unisex', 'female', 'male', 'non_binary') NOT NULL DEFAULT 'unisex' COMMENT 'Target gender demographic' AFTER age_range;

-- ── SEASONAL & TRENDS ─────────────────────────────────────────────────────────

-- Seasonal Product
ALTER TABLE products 
ADD COLUMN is_seasonal BOOLEAN NOT NULL DEFAULT FALSE COMMENT 'Seasonal availability' AFTER gender_target;

-- Season
ALTER TABLE products 
ADD COLUMN season ENUM('spring', 'summer', 'fall', 'winter', 'all_year') NULL COMMENT 'Best season for use' AFTER is_seasonal;

-- Limited Edition
ALTER TABLE products 
ADD COLUMN is_limited_edition BOOLEAN NOT NULL DEFAULT FALSE COMMENT 'Limited edition product' AFTER season;

-- ── SAMPLE PRODUCTS ───────────────────────────────────────────────────────────

-- Is Sample
ALTER TABLE products 
ADD COLUMN is_sample BOOLEAN NOT NULL DEFAULT FALSE COMMENT 'Sample/trial size product' AFTER is_limited_edition;

-- Sample Of Product ID (reference to full-size product)
ALTER TABLE products 
ADD COLUMN sample_of_product_id BIGINT UNSIGNED NULL COMMENT 'Full-size product reference' AFTER is_sample,
ADD CONSTRAINT fk_products_sample_of 
  FOREIGN KEY (sample_of_product_id) 
  REFERENCES products(id) 
  ON DELETE SET NULL;

-- ── VIDEO CONTENT ─────────────────────────────────────────────────────────────

-- Tutorial Video URL
ALTER TABLE products 
ADD COLUMN tutorial_video_url VARCHAR(500) NULL COMMENT 'How-to video URL' AFTER sample_of_product_id;

-- Demo Video URL
ALTER TABLE products 
ADD COLUMN demo_video_url VARCHAR(500) NULL COMMENT 'Product demo video URL' AFTER tutorial_video_url;

-- ── INDEXES FOR PERFORMANCE ───────────────────────────────────────────────────

-- Index for filtering by skin type (JSON search)
-- Note: JSON indexes require MySQL 8.0+, add as needed

-- Index for finish
CREATE INDEX idx_products_finish ON products(finish);

-- Index for coverage
CREATE INDEX idx_products_coverage ON products(coverage);

-- Index for formulation type
CREATE INDEX idx_products_formulation_type ON products(formulation_type);

-- Index for certifications (for common searches)
CREATE INDEX idx_products_is_hypoallergenic ON products(is_hypoallergenic);
CREATE INDEX idx_products_is_non_comedogenic ON products(is_non_comedogenic);

-- Index for sustainability
CREATE INDEX idx_products_is_eco_friendly ON products(is_eco_friendly);
CREATE INDEX idx_products_is_refillable ON products(is_refillable);

-- Index for product classification
CREATE INDEX idx_products_is_professional_use ON products(is_professional_use);
CREATE INDEX idx_products_is_seasonal ON products(is_seasonal);
CREATE INDEX idx_products_is_limited_edition ON products(is_limited_edition);

-- Index for gender targeting
CREATE INDEX idx_products_gender_target ON products(gender_target);

-- Index for sample products
CREATE INDEX idx_products_is_sample ON products(is_sample);
CREATE INDEX idx_products_sample_of ON products(sample_of_product_id);

-- ══════════════════════════════════════════════════════════════════════════════
-- EXAMPLE DATA STRUCTURE FOR JSON FIELDS
-- ══════════════════════════════════════════════════════════════════════════════

-- Benefits JSON example:
-- ["Hydrating", "Anti-Aging", "Brightening", "Firming"]

-- Skin Types JSON example:
-- ["Dry", "Normal", "Combination"]

-- Skin Concerns JSON example:
-- ["Fine Lines", "Dark Spots", "Dullness", "Uneven Texture"]

-- Key Ingredients JSON example:
-- [
--   {"name": "Hyaluronic Acid", "percentage": "2%", "purpose": "Hydration"},
--   {"name": "Niacinamide", "percentage": "5%", "purpose": "Brightening"},
--   {"name": "Vitamin C", "percentage": "10%", "purpose": "Antioxidant"}
-- ]

-- Free From JSON example:
-- ["Parabens", "Sulfates", "Phthalates", "Mineral Oil", "Artificial Fragrance"]

-- Certifications JSON example:
-- [
--   {"type": "Cruelty-Free", "authority": "Leaping Bunny", "year": 2023},
--   {"type": "Vegan", "authority": "Vegan Society", "year": 2023},
--   {"type": "Organic", "authority": "USDA", "year": 2022}
-- ]

-- Claims JSON example:
-- ["Dermatologist Tested", "Clinically Proven", "Allergy Tested", "Ophthalmologist Tested"]

-- Best Used With JSON example:
-- [123, 456, 789] -- Product IDs

-- Regulatory Approvals JSON example:
-- ["USA - FDA", "EU - EU Cosmetics Regulation", "India - BIS", "Canada - Health Canada"]

-- Awards JSON example:
-- [
--   {"name": "Best Face Serum 2023", "authority": "Allure Beauty Awards", "year": 2023},
--   {"name": "Editor's Choice", "authority": "Vogue India", "year": 2023}
-- ]

-- Press Features JSON example:
-- [
--   {"publication": "Elle Magazine", "title": "10 Best Serums", "date": "2023-06-15"},
--   {"publication": "The Times of India", "title": "Skincare Hero Products", "date": "2023-08-20"}
-- ]

-- ══════════════════════════════════════════════════════════════════════════════
-- NOTES
-- ══════════════════════════════════════════════════════════════════════════════

-- 1. JSON fields allow flexible attribute storage without rigid schema
-- 2. Indexes added for commonly filtered fields
-- 3. ENUMs provide controlled vocabularies for consistent data
-- 4. Foreign key maintains referential integrity for sample products
-- 5. All new fields are nullable to maintain backward compatibility
-- 6. Boolean fields default to FALSE for safety

-- ══════════════════════════════════════════════════════════════════════════════
-- MIGRATION STRATEGY
-- ══════════════════════════════════════════════════════════════════════════════

-- This migration adds columns to existing products table
-- No data loss - all new columns are nullable or have defaults
-- Existing products will have NULL/default values for new fields
-- Update products incrementally with new data

-- Run this migration with:
-- mysql -u your_user -p veylog_db < 25_products_cosmetics_enhancement.sql

