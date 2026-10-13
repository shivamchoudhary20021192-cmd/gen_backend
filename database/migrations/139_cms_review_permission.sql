-- =============================================================================
-- 139 — A permission of its own for signing off a page's legal review.
--
-- A page marked requires_legal_review cannot be published until someone
-- records the review. That sign-off was guarded by cms.edit, so anyone who
-- could edit a regulated page could also certify it — the editor marking
-- their own homework. cms.review separates the two.
--
-- Nothing changes on upgrade: every role and every per-person grant (allow or
-- deny) that has cms.edit gets the same for cms.review. A shop that wants the
-- sign-off held by someone else now takes cms.review off its editors' role.
--
-- Idempotent: safe to run again.
-- =============================================================================

SET NAMES utf8mb4;

INSERT IGNORE INTO `permissions` (slug, module, action, name, description, is_dangerous, sort_order) VALUES
  ('cms.review', 'cms', 'review', 'Sign off legal review',
   'Record that a page needing legal review has been reviewed, which is what allows it to be published.', 0, 0);

INSERT IGNORE INTO `role_permissions` (shop_id, role_id, permission_id)
SELECT DISTINCT rp.shop_id, rp.role_id, target.id
  FROM `role_permissions` rp
  JOIN `permissions` source ON source.id = rp.permission_id AND source.slug = 'cms.edit'
  JOIN `permissions` target ON target.slug = 'cms.review';

INSERT IGNORE INTO `admin_user_permissions` (shop_id, admin_user_id, permission_id, effect, expires_at, granted_by_admin_id)
SELECT aup.shop_id, aup.admin_user_id, target.id, aup.effect, aup.expires_at, aup.granted_by_admin_id
  FROM `admin_user_permissions` aup
  JOIN `permissions` source ON source.id = aup.permission_id AND source.slug = 'cms.edit'
  JOIN `permissions` target ON target.slug = 'cms.review';
