-- ────────────────────────────────────────────────────────────────────────────
-- 34 — starter content for the CMS
--
--   mysql -u <user> -p <database> < database/34_content_starter.sql
--
-- The pages, FAQs and journal categories the storefront needs on day one. The
-- footer already links to "Shipping & delivery", "Returns" and "Contact us";
-- until now those links all pointed at /shop because the pages did not exist.
--
-- Every INSERT is guarded on its own slug, so this is safe to run more than
-- once and will not overwrite anything you have since edited in the admin.
-- The wording is a reasonable starting point written to be replaced — read it
-- before you publish it, and put your real GST number, address and timelines in.
-- ────────────────────────────────────────────────────────────────────────────

-- The client connection has to be told the file is UTF-8. Without this the
-- em dashes and rupee signs below arrive as latin-1 bytes and land in the
-- column as "â€"" — which then renders that way on the live storefront.
SET NAMES utf8mb4;

-- ── pages ───────────────────────────────────────────────────────────────────
-- Published on insert: a policy page that exists but is invisible is the same
-- as no policy page, and these are exactly the ones a shopper looks for before
-- their first order.

INSERT INTO cms_pages (slug, full_path, title, subtitle, page_type, template, body_html, status, published_at, is_indexable, show_in_sitemap)
SELECT 'shipping', '/pages/shipping', 'Shipping & delivery',
       'Where we ship, how long it takes, and what it costs.',
       'policy', 'default',
       '<h2>Where we ship</h2><p>We ship across India. We do not ship internationally yet.</p><h2>Dispatch</h2><p>Orders placed before 2pm on a working day are usually dispatched the same day. Orders placed after that, or on a Sunday or public holiday, go out the next working day.</p><h2>Delivery times</h2><ul><li><strong>Metro cities</strong> — 2 to 4 working days</li><li><strong>Rest of India</strong> — 4 to 7 working days</li><li><strong>Remote pin codes</strong> — up to 10 working days</li></ul><h2>Charges</h2><p>Delivery is free on prepaid orders above Rs 999. Below that a flat delivery charge applies and is shown at checkout before you pay.</p><h2>Tracking</h2><p>You get a tracking link by SMS and email as soon as your parcel is handed to the courier. You can also track it from the <a href="/track">track your order</a> page using your order number and phone.</p><p><em>Replace these timelines and charges with your own before publishing.</em></p>',
       'published', NOW(), 1, 1
WHERE NOT EXISTS (SELECT 1 FROM cms_pages WHERE slug = 'shipping');

INSERT INTO cms_pages (slug, full_path, title, subtitle, page_type, template, body_html, status, published_at, is_indexable, show_in_sitemap)
SELECT 'returns', '/pages/returns', 'Returns & refunds',
       'What can be returned, by when, and how the money comes back.',
       'policy', 'default',
       '<h2>What you can return</h2><p>Unopened products in their original packaging can be returned within 7 days of delivery.</p><h2>What you cannot return</h2><p>For hygiene and safety reasons we cannot take back a product whose seal has been broken, unless it reached you damaged or is faulty. If something arrived damaged, tell us within 48 hours with a photo and we will replace it.</p><h2>How to start a return</h2><p>Reply to your order confirmation, or reach us on the <a href="/pages/contact">contact page</a> with your order number. We arrange a pickup where the courier serves your pin code.</p><h2>Refunds</h2><p>Once the product is back with us and checked, the refund is issued to the original payment method within 5 to 7 working days. For cash on delivery orders we refund to a bank account you tell us.</p><p><em>Replace these windows and terms with your own before publishing.</em></p>',
       'published', NOW(), 1, 1
WHERE NOT EXISTS (SELECT 1 FROM cms_pages WHERE slug = 'returns');

INSERT INTO cms_pages (slug, full_path, title, subtitle, page_type, template, body_html, status, published_at, is_indexable, show_in_sitemap)
SELECT 'contact', '/pages/contact', 'Contact us',
       'A real person reads these.',
       'support', 'default',
       '<h2>Talk to us</h2><p>Email <a href="mailto:hello@veylor.co.in">hello@veylor.co.in</a> and we answer within one working day.</p><h2>About an order</h2><p>Have your order number ready — it is in your confirmation SMS and starts with VEY. You can also check where a parcel is on the <a href="/track">track your order</a> page without writing to us at all.</p><h2>About your skin</h2><p>If you are not sure whether a product suits you, write to us before you buy. We would rather talk you out of the wrong product than process a return.</p><p><em>Put your real address, GST number and support hours here before publishing.</em></p>',
       'published', NOW(), 1, 1
WHERE NOT EXISTS (SELECT 1 FROM cms_pages WHERE slug = 'contact');

INSERT INTO cms_pages (slug, full_path, title, subtitle, page_type, template, body_html, status, published_at, is_indexable, show_in_sitemap)
SELECT 'privacy', '/pages/privacy', 'Privacy policy',
       'What we collect, why, and what you can ask us to delete.',
       'policy', 'default',
       '<h2>What we collect</h2><p>Your name, phone number, email address and delivery address, so we can take an order and get it to you. Payment details are handled by our payment provider and never reach our servers.</p><h2>Why we keep it</h2><p>To fulfil your orders, to answer you when you write in, and — only if you have opted in — to tell you about products you saved or left in your bag.</p><h2>Marketing messages</h2><p>We only send marketing on WhatsApp, SMS or email if you have said yes. You can withdraw that at any time, and we stop.</p><h2>Your rights</h2><p>Under the Digital Personal Data Protection Act you can ask us for a copy of your data, ask us to correct it, or ask us to delete it. Write to <a href="mailto:privacy@veylor.co.in">privacy@veylor.co.in</a>.</p><p><em>Have this reviewed before you publish it. This is a starting point, not legal advice.</em></p>',
       'published', NOW(), 1, 1
WHERE NOT EXISTS (SELECT 1 FROM cms_pages WHERE slug = 'privacy');

INSERT INTO cms_pages (slug, full_path, title, subtitle, page_type, template, body_html, status, published_at, is_indexable, show_in_sitemap)
SELECT 'about', '/pages/about', 'Our story',
       'Formulated in India, for Indian skin and Indian weather.',
       'about', 'default',
       '<h2>Why Veylor exists</h2><p>Most of what reaches Indian shelves was formulated for other climates and other skin. Humidity, hard water, sun that does not let up for eight months of the year — these change what a product has to do.</p><h2>How we formulate</h2><p>Small ingredient lists, concentrations we are willing to print on the box, and no claim we cannot point to evidence for. Every product lists its full INCI, and every article in our <a href="/journal">journal</a> that touches on safety carries the name of the person who reviewed it.</p><p><em>Write your own story here — this is a placeholder.</em></p>',
       'published', NOW(), 1, 1
WHERE NOT EXISTS (SELECT 1 FROM cms_pages WHERE slug = 'about');

-- ── FAQs ────────────────────────────────────────────────────────────────────
-- Grouped so the FAQ page has sections rather than one long scroll.

INSERT INTO cms_faqs (group_id, question, answer, sort_order, is_published)
SELECT g.id, 'How long does delivery take?',
       'Two to four working days in metro cities and four to seven elsewhere. Remote pin codes can take up to ten. You get a tracking link as soon as the parcel leaves us.',
       0, 1
  FROM cms_faq_groups g
 WHERE g.slug = 'shipping'
   AND NOT EXISTS (SELECT 1 FROM cms_faqs f WHERE f.question = 'How long does delivery take?');

INSERT INTO cms_faqs (group_id, question, answer, sort_order, is_published)
SELECT g.id, 'Is delivery free?',
       'Free on prepaid orders above Rs 999. Below that a flat charge applies, and it is shown at checkout before you pay.',
       1, 1
  FROM cms_faq_groups g
 WHERE g.slug = 'shipping'
   AND NOT EXISTS (SELECT 1 FROM cms_faqs f WHERE f.question = 'Is delivery free?');

INSERT INTO cms_faqs (group_id, question, answer, sort_order, is_published)
SELECT g.id, 'Can I return a product I have opened?',
       'Only if it reached you damaged or is faulty. Skincare is sealed for hygiene, so an opened product cannot go back into stock. If something is wrong with it, tell us within 48 hours with a photo and we will replace it.',
       0, 1
  FROM cms_faq_groups g
 WHERE g.slug = 'returns'
   AND NOT EXISTS (SELECT 1 FROM cms_faqs f WHERE f.question = 'Can I return a product I have opened?');

INSERT INTO cms_faqs (group_id, question, answer, sort_order, is_published)
SELECT g.id, 'When do I get my refund?',
       'Within five to seven working days of the product reaching us and being checked. It goes back to the way you paid. For cash on delivery orders we refund to a bank account you give us.',
       1, 1
  FROM cms_faq_groups g
 WHERE g.slug = 'returns'
   AND NOT EXISTS (SELECT 1 FROM cms_faqs f WHERE f.question = 'When do I get my refund?');

INSERT INTO cms_faqs (group_id, question, answer, sort_order, is_published)
SELECT g.id, 'Which payment methods do you accept?',
       'UPI, credit and debit cards, net banking and wallets through Razorpay, and cash on delivery on most pin codes. We never see or store your card details.',
       0, 1
  FROM cms_faq_groups g
 WHERE g.slug = 'payments'
   AND NOT EXISTS (SELECT 1 FROM cms_faqs f WHERE f.question = 'Which payment methods do you accept?');

INSERT INTO cms_faqs (group_id, question, answer, sort_order, is_published)
SELECT g.id, 'Is cash on delivery available everywhere?',
       'On most pin codes. If it is not available on yours, the option simply will not appear at checkout.',
       1, 1
  FROM cms_faq_groups g
 WHERE g.slug = 'payments'
   AND NOT EXISTS (SELECT 1 FROM cms_faqs f WHERE f.question = 'Is cash on delivery available everywhere?');

INSERT INTO cms_faqs (group_id, question, answer, sort_order, is_published)
SELECT g.id, 'Should I patch test?',
       'Yes, especially with actives. Put a small amount behind your ear or on your inner forearm and leave it 24 hours. If there is redness, itching or stinging that does not settle, stop using it.',
       0, 1
  FROM cms_faq_groups g
 WHERE g.slug = 'products'
   AND NOT EXISTS (SELECT 1 FROM cms_faqs f WHERE f.question = 'Should I patch test?');

INSERT INTO cms_faqs (group_id, question, answer, sort_order, is_published)
SELECT g.id, 'How long before I see a difference?',
       'It depends on what you are treating. Hydration shows in days; texture and tone take six to twelve weeks of consistent use. Anything promising more than that in less time is worth being suspicious of.',
       1, 1
  FROM cms_faq_groups g
 WHERE g.slug = 'products'
   AND NOT EXISTS (SELECT 1 FROM cms_faqs f WHERE f.question = 'How long before I see a difference?');

INSERT INTO cms_faqs (group_id, question, answer, sort_order, is_published)
SELECT g.id, 'Are your products tested on animals?',
       'No. Neither the finished products nor the ingredients we buy are tested on animals.',
       0, 1
  FROM cms_faq_groups g
 WHERE g.slug = 'general'
   AND NOT EXISTS (SELECT 1 FROM cms_faqs f WHERE f.question = 'Are your products tested on animals?');

-- ── the journal's first article ─────────────────────────────────────────────
-- Left as a DRAFT on purpose. The publish endpoint refuses an article with no
-- excerpt or body for a reason, and a seeded article going live under a real
-- brand's name without anyone reading it is exactly what that guard is for.

INSERT INTO cms_articles (blog_id, category_id, slug, title, subtitle, excerpt, body_html,
                          author_name, author_title, read_time_minutes, status, is_indexable)
SELECT b.id, c.id, 'how-to-layer-a-morning-routine',
       'How to layer a morning routine',
       'Thinnest to thickest, and sunscreen last.',
       'The order you apply things in changes how much of each one actually reaches your skin. Here is the rule, and the three places people usually get it wrong.',
       '<p>The rule is simple enough to remember: <strong>thinnest to thickest, sunscreen last</strong>. Everything else is detail.</p><h2>The order</h2><ol><li><strong>Cleanser</strong> — lukewarm water, thirty seconds, no scrubbing.</li><li><strong>Watery treatments</strong> — anything that runs off your fingers.</li><li><strong>Serum</strong> — the active you are actually there for.</li><li><strong>Moisturiser</strong> — seals the layers under it.</li><li><strong>Sunscreen</strong> — always last, always the full amount.</li></ol><h2>Where it goes wrong</h2><p><strong>Not enough sunscreen.</strong> Two fingers'' length for the face and neck. Most people use a third of what they need and get a third of the protection.</p><p><strong>Rushing between layers.</strong> Give each one a minute. A serum that has not absorbed cannot do anything under a moisturiser.</p><p><strong>Too many actives at once.</strong> One is usually enough in the morning. Save the rest for the evening, or for a different day.</p><p><em>This is a seeded draft. Edit it, have it reviewed, then publish.</em></p>',
       'Veylor', 'Formulation team', 3, 'draft', 1
  FROM cms_blogs b, cms_article_categories c
 WHERE b.slug = 'journal' AND c.slug = 'routine'
   AND NOT EXISTS (SELECT 1 FROM cms_articles WHERE slug = 'how-to-layer-a-morning-routine');

SELECT 'Migration 34 applied.' AS result;
