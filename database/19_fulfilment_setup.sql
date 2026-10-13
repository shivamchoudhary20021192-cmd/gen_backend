-- ─────────────────────────────────────────────────────────────────────────────
-- Reference data for shipments, returns and invoices.
--
-- Three things the fulfilment modules need before they can do anything:
--
--   1. Carriers to ship with. `api_provider` is the hook the courier adapter
--      dispatches on — 'dummy' generates plausible AWBs locally, and swapping a
--      row to 'shiprocket' or 'bluedart' is what switches it to a real vendor
--      once those adapters and their credentials exist. The tracking URL
--      templates are the real public ones, so a dummy AWB still produces a link
--      of the right shape.
--
--   2. A seller identity on the default warehouse. A GST tax invoice needs the
--      supplier's legal name, GSTIN and state — and the state is what decides
--      CGST+SGST versus IGST on every order. Replace these with your real
--      registration details before issuing anything to a customer.
--
--   3. Counters for the document numbers, so RMAs, shipments and invoices are
--      issued the same race-free way order numbers are (see migration 17).
--
-- Idempotent: safe to run more than once.
-- ─────────────────────────────────────────────────────────────────────────────

-- ── 1. carriers ──────────────────────────────────────────────────────────────
INSERT INTO shipping_carriers
  (code, name, tracking_url_template, api_provider, supports_cod, supports_reverse_pickup, is_active, priority)
VALUES
  ('shiprocket', 'Shiprocket', 'https://shiprocket.co/tracking/{awb}', 'dummy', 1, 1, 1, 10),
  ('bluedart',   'Blue Dart',  'https://www.bluedart.com/tracking?trackFor=0&trackNo={awb}', 'dummy', 1, 1, 1, 20),
  ('delhivery',  'Delhivery',  'https://www.delhivery.com/track/package/{awb}', 'dummy', 1, 1, 1, 30),
  ('manual',     'Manual / self-ship', NULL, 'manual', 1, 0, 1, 90)
ON DUPLICATE KEY UPDATE
  name = VALUES(name),
  tracking_url_template = VALUES(tracking_url_template),
  supports_cod = VALUES(supports_cod),
  supports_reverse_pickup = VALUES(supports_reverse_pickup),
  is_active = VALUES(is_active),
  priority = VALUES(priority);

-- ── 2. the seller, on the default warehouse ──────────────────────────────────
-- Only filled where it is still blank, so a real address entered in the admin
-- is never overwritten by re-running this.
UPDATE inventory_locations
   SET line1        = COALESCE(line1, 'Plot 44, Baddi Industrial Area'),
       city         = COALESCE(city, 'Solan'),
       state        = COALESCE(state, 'Himachal Pradesh'),
       state_code   = COALESCE(state_code, '02'),
       pincode      = COALESCE(pincode, '173205'),
       country      = COALESCE(country, 'IN'),
       gstin        = COALESCE(gstin, '02AABCV1234F1Z5'),
       contact_name = COALESCE(contact_name, 'Veylor Labs Private Limited'),
       contact_phone = COALESCE(contact_phone, '18002004455')
 WHERE is_default = 1;

-- The legal entity that appears on the invoice, separate from the warehouse
-- that ships it — a 3PL address is not who the customer bought from.
INSERT INTO settings (group_key, setting_key, label, value, value_type, description, is_public, sort_order)
VALUES
  ('invoice', 'seller_legal_name', 'Legal entity name', 'Veylor Labs Private Limited', 'string',
   'Printed as the supplier on every tax invoice.', 0, 10),
  ('invoice', 'seller_gstin', 'Seller GSTIN', '02AABCV1234F1Z5', 'string',
   'Replace with your real GSTIN before issuing invoices to customers.', 0, 20),
  ('invoice', 'seller_address', 'Registered address',
   '2nd Floor, Indiranagar 100 Ft Road, Bengaluru, Karnataka 560038', 'string',
   'The registered office address printed on the invoice.', 0, 30),
  ('invoice', 'invoice_prefix', 'Invoice number prefix', 'INV', 'string',
   'Changing this mid-year breaks the sequence auditors expect.', 0, 40)
ON DUPLICATE KEY UPDATE label = VALUES(label), description = VALUES(description);

-- ── 3. document counters ─────────────────────────────────────────────────────
INSERT IGNORE INTO number_sequences (name, prefix, current_value, padding)
VALUES
  ('shipment', 'SHP', 0, 6),
  ('rma',      'RMA', 0, 6),
  ('invoice',  'INV', 0, 6),
  ('credit_note', 'CRN', 0, 6);

-- Start each counter above anything already issued, so a database with history
-- does not immediately collide. Non-numeric legacy numbers are ignored — they
-- are exactly the rows that break a MAX()-based scheme.
UPDATE number_sequences s
   SET s.current_value = GREATEST(s.current_value, COALESCE((
     SELECT MAX(CAST(SUBSTRING(x.shipment_number, CHAR_LENGTH(s.prefix) + 1) AS UNSIGNED))
       FROM shipments x
      WHERE x.shipment_number REGEXP CONCAT('^', s.prefix, '[0-9]+$')
   ), 0))
 WHERE s.name = 'shipment';

UPDATE number_sequences s
   SET s.current_value = GREATEST(s.current_value, COALESCE((
     SELECT MAX(CAST(SUBSTRING(x.rma_number, CHAR_LENGTH(s.prefix) + 1) AS UNSIGNED))
       FROM return_requests x
      WHERE x.rma_number REGEXP CONCAT('^', s.prefix, '[0-9]+$')
   ), 0))
 WHERE s.name = 'rma';

UPDATE number_sequences s
   SET s.current_value = GREATEST(s.current_value, COALESCE((
     SELECT MAX(CAST(SUBSTRING(x.invoice_number, CHAR_LENGTH(s.prefix) + 1) AS UNSIGNED))
       FROM invoices x
      WHERE x.invoice_number REGEXP CONCAT('^', s.prefix, '[0-9]+$')
   ), 0))
 WHERE s.name IN ('invoice', 'credit_note');

-- ── 4. backfill place of supply ──────────────────────────────────────────────
-- Orders placed before the checkout derived a state code have none, and without
-- it an invoice cannot decide CGST/SGST versus IGST. Only the unambiguous
-- states are filled; anything else stays null and the invoice screen says so.
UPDATE order_addresses SET state_code = '29' WHERE state_code IS NULL AND LOWER(TRIM(state)) = 'karnataka';
UPDATE order_addresses SET state_code = '27' WHERE state_code IS NULL AND LOWER(TRIM(state)) = 'maharashtra';
UPDATE order_addresses SET state_code = '07' WHERE state_code IS NULL AND LOWER(TRIM(state)) IN ('delhi', 'new delhi');
UPDATE order_addresses SET state_code = '33' WHERE state_code IS NULL AND LOWER(TRIM(state)) = 'tamil nadu';
UPDATE order_addresses SET state_code = '36' WHERE state_code IS NULL AND LOWER(TRIM(state)) = 'telangana';
UPDATE order_addresses SET state_code = '24' WHERE state_code IS NULL AND LOWER(TRIM(state)) = 'gujarat';
UPDATE order_addresses SET state_code = '19' WHERE state_code IS NULL AND LOWER(TRIM(state)) = 'west bengal';
UPDATE order_addresses SET state_code = '09' WHERE state_code IS NULL AND LOWER(TRIM(state)) = 'uttar pradesh';
UPDATE order_addresses SET state_code = '32' WHERE state_code IS NULL AND LOWER(TRIM(state)) = 'kerala';
UPDATE order_addresses SET state_code = '08' WHERE state_code IS NULL AND LOWER(TRIM(state)) = 'rajasthan';

-- ── 5. HSN on the catalogue ──────────────────────────────────────────────────
-- HSN is mandatory on a GST invoice, and it comes from the product's tax class.
-- No product had one assigned, so every invoice line printed "—". 3304 is the
-- heading for beauty and skincare preparations, which is what the whole range
-- is; anything needing 3307 can be moved in the admin.
UPDATE products
   SET tax_class_id = (SELECT id FROM tax_classes WHERE hsn_code = '3304' LIMIT 1)
 WHERE tax_class_id IS NULL AND deleted_at IS NULL;
