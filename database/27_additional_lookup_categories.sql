-- ============================================================================
-- ADDITIONAL LOOKUP CATEGORIES FOR DROPDOWNS
-- Adding more dropdown options as requested
-- ============================================================================

-- Add new categories
INSERT INTO lookup_categories (code, name, description, allow_custom, sort_order) VALUES
('usage_instructions', 'Usage Instructions', 'Common usage instructions templates', TRUE, 18),
('feel_on_skin', 'Feel on Skin', 'Sensory descriptions for product feel', TRUE, 19);

-- Usage Instructions (Common patterns)
INSERT INTO lookup_values (category_id, code, label, description, sort_order) VALUES
((SELECT id FROM lookup_categories WHERE code = 'usage_instructions'), 'apply_am_pm', 'Apply morning and evening', 'Daily application twice a day', 1),
((SELECT id FROM lookup_categories WHERE code = 'usage_instructions'), 'apply_clean_skin', 'Apply to clean, dry skin', 'After cleansing and drying', 2),
((SELECT id FROM lookup_categories WHERE code = 'usage_instructions'), 'apply_damp_skin', 'Apply to clean, damp skin', 'After cleansing while still damp', 3),
((SELECT id FROM lookup_categories WHERE code = 'usage_instructions'), 'apply_2_3_drops', 'Apply 2-3 drops', 'Small amount application', 4),
((SELECT id FROM lookup_categories WHERE code = 'usage_instructions'), 'apply_thin_layer', 'Apply a thin layer', 'Even coverage', 5),
((SELECT id FROM lookup_categories WHERE code = 'usage_instructions'), 'apply_generous_amount', 'Apply a generous amount', 'Liberal application', 6),
((SELECT id FROM lookup_categories WHERE code = 'usage_instructions'), 'massage_gently', 'Massage gently into skin', 'Gentle circular motions', 7),
((SELECT id FROM lookup_categories WHERE code = 'usage_instructions'), 'pat_until_absorbed', 'Pat until fully absorbed', 'Light patting motion', 8),
((SELECT id FROM lookup_categories WHERE code = 'usage_instructions'), 'use_before_moisturizer', 'Use before moisturizer', 'Apply in skincare routine order', 9),
((SELECT id FROM lookup_categories WHERE code = 'usage_instructions'), 'use_after_serum', 'Use after serum', 'Apply after treatment products', 10),
((SELECT id FROM lookup_categories WHERE code = 'usage_instructions'), 'avoid_eye_area', 'Avoid eye area', 'Keep away from eyes', 11),
((SELECT id FROM lookup_categories WHERE code = 'usage_instructions'), 'use_sunscreen_after', 'Follow with sunscreen (AM)', 'Apply SPF after this product', 12),
((SELECT id FROM lookup_categories WHERE code = 'usage_instructions'), 'use_2_3_times_week', 'Use 2-3 times per week', 'Not for daily use', 13),
((SELECT id FROM lookup_categories WHERE code = 'usage_instructions'), 'leave_on_overnight', 'Leave on overnight', 'Night treatment', 14),
((SELECT id FROM lookup_categories WHERE code = 'usage_instructions'), 'rinse_after_10_min', 'Rinse after 10-15 minutes', 'Wash-off product', 15);

-- Feel on Skin
INSERT INTO lookup_values (category_id, code, label, description, sort_order) VALUES
((SELECT id FROM lookup_categories WHERE code = 'feel_on_skin'), 'lightweight', 'Lightweight', 'Barely noticeable on skin', 1),
((SELECT id FROM lookup_categories WHERE code = 'feel_on_skin'), 'silky', 'Silky', 'Smooth, silky texture', 2),
((SELECT id FROM lookup_categories WHERE code = 'feel_on_skin'), 'velvety', 'Velvety', 'Soft, velvety finish', 3),
((SELECT id FROM lookup_categories WHERE code = 'feel_on_skin'), 'smooth', 'Smooth', 'Glides on smoothly', 4),
((SELECT id FROM lookup_categories WHERE code = 'feel_on_skin'), 'cooling', 'Cooling', 'Refreshing, cooling sensation', 5),
((SELECT id FROM lookup_categories WHERE code = 'feel_on_skin'), 'soothing', 'Soothing', 'Calming, comforting feel', 6),
((SELECT id FROM lookup_categories WHERE code = 'feel_on_skin'), 'non_sticky', 'Non-Sticky', 'No sticky residue', 7),
((SELECT id FROM lookup_categories WHERE code = 'feel_on_skin'), 'non_greasy', 'Non-Greasy', 'No oily feeling', 8),
((SELECT id FROM lookup_categories WHERE code = 'feel_on_skin'), 'fast_absorbing', 'Fast Absorbing', 'Absorbs quickly', 9),
((SELECT id FROM lookup_categories WHERE code = 'feel_on_skin'), 'hydrating', 'Hydrating', 'Moisturizing feel', 10),
((SELECT id FROM lookup_categories WHERE code = 'feel_on_skin'), 'nourishing', 'Nourishing', 'Rich, nourishing feel', 11),
((SELECT id FROM lookup_categories WHERE code = 'feel_on_skin'), 'cushiony', 'Cushiony', 'Soft, cushion-like texture', 12),
((SELECT id FROM lookup_categories WHERE code = 'feel_on_skin'), 'weightless', 'Weightless', 'Feels like nothing on skin', 13),
((SELECT id FROM lookup_categories WHERE code = 'feel_on_skin'), 'comfortable', 'Comfortable', 'Comfortable all-day wear', 14),
((SELECT id FROM lookup_categories WHERE code = 'feel_on_skin'), 'breathable', 'Breathable', 'Allows skin to breathe', 15),
((SELECT id FROM lookup_categories WHERE code = 'feel_on_skin'), 'tightening', 'Tightening', 'Slight tightening sensation', 16);

-- Note: application_method, packaging_type, and age_range already exist in the main migration
-- Just verifying they're properly set up as dropdowns

-- ============================================================================
-- VERIFICATION QUERIES (for testing)
-- ============================================================================

-- Check all categories
-- SELECT * FROM lookup_categories ORDER BY sort_order;

-- Check usage_instructions values
-- SELECT lv.* FROM lookup_values lv
-- JOIN lookup_categories lc ON lv.category_id = lc.id
-- WHERE lc.code = 'usage_instructions'
-- ORDER BY lv.sort_order;

-- Check feel_on_skin values
-- SELECT lv.* FROM lookup_values lv
-- JOIN lookup_categories lc ON lv.category_id = lc.id
-- WHERE lc.code = 'feel_on_skin'
-- ORDER BY lv.sort_order;
