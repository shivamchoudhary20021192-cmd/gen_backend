-- =============================================================================
-- File 11 : REVIEWS AND UGC
-- =============================================================================
-- BRD FR-10: "Reviews require moderation, verified-order attribution and abuse
-- controls." And §14: "Permission, moderation, incentives disclosed, no
-- fabricated reviews."
--
-- Hence: every review starts at status='pending'; verification is proven by a
-- real `order_item_id`, not a boolean someone can flip; and `is_incentivized`
-- exists so a gifted or discounted review can be disclosed on the page.
--
-- Review photos attach through `media_attachments` with
-- attachable_type='review', so UGC lives in the same library as everything
-- else and inherits the same variants, moderation and storage migration.
-- =============================================================================

USE `veylog`;

CREATE TABLE `reviews` (
  `id`                   BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `public_id`            CHAR(36)        NOT NULL DEFAULT (UUID()),
  `product_id`           BIGINT UNSIGNED NOT NULL,
  `variant_id`           BIGINT UNSIGNED     NULL,
  `customer_id`          BIGINT UNSIGNED     NULL,
  `order_id`             BIGINT UNSIGNED     NULL,
  -- Non-NULL is the ONLY thing that earns the "verified purchase" badge.
  `order_item_id`        BIGINT UNSIGNED     NULL,

  `author_name`          VARCHAR(120)    NOT NULL,   -- 'Priya S.'
  `author_location`      VARCHAR(120)        NULL,
  `author_email`         VARCHAR(191)        NULL,   -- never displayed
  `rating`               TINYINT UNSIGNED NOT NULL,
  `title`                VARCHAR(200)        NULL,
  `body`                 TEXT                NULL,

  -- review filters on the PDP
  `skin_type_id`         BIGINT UNSIGNED     NULL,
  `concern_id`           BIGINT UNSIGNED     NULL,
  `age_range`            VARCHAR(20)         NULL,
  `usage_duration`       VARCHAR(40)         NULL,   -- '4-8 weeks'
  `would_recommend`      TINYINT(1) UNSIGNED NULL,

  `is_verified_purchase` TINYINT(1) UNSIGNED NOT NULL DEFAULT 0,
  `is_incentivized`      TINYINT(1) UNSIGNED NOT NULL DEFAULT 0,  -- must be disclosed
  `has_media`            TINYINT(1) UNSIGNED NOT NULL DEFAULT 0,

  `status`               ENUM('pending','approved','rejected','spam','hidden')
                                         NOT NULL DEFAULT 'pending',
  `rejection_reason`     VARCHAR(255)        NULL,
  `moderated_by_admin_id` BIGINT UNSIGNED    NULL,
  `moderated_at`         DATETIME            NULL,
  `moderation_note`      VARCHAR(500)        NULL,
  -- A review describing irritation is a safety signal, not just feedback.
  -- Flagging it here routes it into the adverse-event workflow (file 12).
  `flagged_adverse_reaction` TINYINT(1) UNSIGNED NOT NULL DEFAULT 0,

  `helpful_count`        INT UNSIGNED    NOT NULL DEFAULT 0,
  `not_helpful_count`    INT UNSIGNED    NOT NULL DEFAULT 0,
  `report_count`         SMALLINT UNSIGNED NOT NULL DEFAULT 0,
  `source`               ENUM('web','email_invite','whatsapp','import','admin')
                                         NOT NULL DEFAULT 'web',
  `ip`                   VARBINARY(16)       NULL,
  `published_at`         DATETIME            NULL,
  `created_at`           DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at`           DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  `deleted_at`           DATETIME            NULL,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_reviews_public_id` (`public_id`),
  -- one review per purchased line, so a repeat buyer can review again
  UNIQUE KEY `uq_reviews_order_item` (`order_item_id`),
  KEY `ix_reviews_product_display` (`product_id`, `status`, `published_at`),
  KEY `ix_reviews_customer` (`customer_id`, `created_at`),
  KEY `ix_reviews_moderation` (`status`, `created_at`),
  KEY `ix_reviews_rating` (`product_id`, `rating`),
  CONSTRAINT `fk_reviews_product`
    FOREIGN KEY (`product_id`) REFERENCES `products` (`id`) ON DELETE CASCADE,
  CONSTRAINT `fk_reviews_variant`
    FOREIGN KEY (`variant_id`) REFERENCES `product_variants` (`id`) ON DELETE SET NULL,
  CONSTRAINT `fk_reviews_customer`
    FOREIGN KEY (`customer_id`) REFERENCES `customers` (`id`) ON DELETE SET NULL,
  CONSTRAINT `fk_reviews_order`
    FOREIGN KEY (`order_id`) REFERENCES `orders` (`id`) ON DELETE SET NULL,
  CONSTRAINT `fk_reviews_order_item`
    FOREIGN KEY (`order_item_id`) REFERENCES `order_items` (`id`) ON DELETE SET NULL,
  CONSTRAINT `fk_reviews_skin_type`
    FOREIGN KEY (`skin_type_id`) REFERENCES `skin_types` (`id`) ON DELETE SET NULL,
  CONSTRAINT `fk_reviews_concern`
    FOREIGN KEY (`concern_id`) REFERENCES `skin_concerns` (`id`) ON DELETE SET NULL,
  CONSTRAINT `fk_reviews_moderator`
    FOREIGN KEY (`moderated_by_admin_id`) REFERENCES `admin_users` (`id`) ON DELETE SET NULL,
  CONSTRAINT `ck_reviews_rating` CHECK (`rating` BETWEEN 1 AND 5)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

-- voter_hash = sha256(customer_id or ip + salt), so guests can vote once
-- without storing another identifier.
CREATE TABLE `review_votes` (
  `id`          BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `review_id`   BIGINT UNSIGNED NOT NULL,
  `customer_id` BIGINT UNSIGNED     NULL,
  `voter_hash`  CHAR(64)        NOT NULL,
  `is_helpful`  TINYINT(1) UNSIGNED NOT NULL DEFAULT 1,
  `created_at`  DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_review_votes` (`review_id`, `voter_hash`),
  KEY `ix_review_votes_customer` (`customer_id`),
  CONSTRAINT `fk_review_votes_review`
    FOREIGN KEY (`review_id`) REFERENCES `reviews` (`id`) ON DELETE CASCADE,
  CONSTRAINT `fk_review_votes_customer`
    FOREIGN KEY (`customer_id`) REFERENCES `customers` (`id`) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

-- Brand response, shown under the review
CREATE TABLE `review_replies` (
  `id`            BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `review_id`     BIGINT UNSIGNED NOT NULL,
  `admin_user_id` BIGINT UNSIGNED     NULL,
  `display_name`  VARCHAR(120)    NOT NULL DEFAULT 'Veylor',
  `body`          TEXT            NOT NULL,
  `is_public`     TINYINT(1) UNSIGNED NOT NULL DEFAULT 1,
  `published_at`  DATETIME            NULL,
  `created_at`    DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at`    DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  KEY `ix_review_replies_review` (`review_id`),
  CONSTRAINT `fk_review_replies_review`
    FOREIGN KEY (`review_id`) REFERENCES `reviews` (`id`) ON DELETE CASCADE,
  CONSTRAINT `fk_review_replies_admin`
    FOREIGN KEY (`admin_user_id`) REFERENCES `admin_users` (`id`) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE `review_reports` (
  `id`                  BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `review_id`           BIGINT UNSIGNED NOT NULL,
  `reporter_customer_id` BIGINT UNSIGNED    NULL,
  `reporter_hash`       CHAR(64)            NULL,
  `reason`              ENUM('spam','offensive','fake','off_topic','personal_data','other')
                                        NOT NULL,
  `detail`              VARCHAR(500)        NULL,
  `status`              ENUM('open','reviewed','dismissed','actioned') NOT NULL DEFAULT 'open',
  `handled_by_admin_id` BIGINT UNSIGNED     NULL,
  `created_at`          DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  KEY `ix_review_reports_review` (`review_id`, `status`),
  CONSTRAINT `fk_review_reports_review`
    FOREIGN KEY (`review_id`) REFERENCES `reviews` (`id`) ON DELETE CASCADE,
  CONSTRAINT `fk_review_reports_customer`
    FOREIGN KEY (`reporter_customer_id`) REFERENCES `customers` (`id`) ON DELETE SET NULL,
  CONSTRAINT `fk_review_reports_admin`
    FOREIGN KEY (`handled_by_admin_id`) REFERENCES `admin_users` (`id`) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

-- Post-delivery review request. The token both authenticates the submission and
-- proves the purchase, so a review can be left without logging in again.
CREATE TABLE `review_invitations` (
  `id`            BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `order_id`      BIGINT UNSIGNED NOT NULL,
  `order_item_id` BIGINT UNSIGNED NOT NULL,
  `customer_id`   BIGINT UNSIGNED     NULL,
  `token`         CHAR(36)        NOT NULL DEFAULT (UUID()),
  `channel`       ENUM('email','sms','whatsapp') NOT NULL DEFAULT 'email',
  `status`        ENUM('scheduled','sent','opened','submitted','expired')
                                  NOT NULL DEFAULT 'scheduled',
  `scheduled_for` DATETIME            NULL,
  `sent_at`       DATETIME            NULL,
  `opened_at`     DATETIME            NULL,
  `submitted_at`  DATETIME            NULL,
  `expires_at`    DATETIME            NULL,
  `created_at`    DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_review_invitations_token` (`token`),
  UNIQUE KEY `uq_review_invitations_item` (`order_item_id`),
  KEY `ix_review_invitations_status` (`status`, `scheduled_for`),
  CONSTRAINT `fk_review_invitations_order`
    FOREIGN KEY (`order_id`) REFERENCES `orders` (`id`) ON DELETE CASCADE,
  CONSTRAINT `fk_review_invitations_item`
    FOREIGN KEY (`order_item_id`) REFERENCES `order_items` (`id`) ON DELETE CASCADE,
  CONSTRAINT `fk_review_invitations_customer`
    FOREIGN KEY (`customer_id`) REFERENCES `customers` (`id`) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
