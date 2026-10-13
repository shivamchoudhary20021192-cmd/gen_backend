import { z } from 'zod';
import { shopPhone } from '../../platform/geo/phone';

// ── admin ────────────────────────────────────────────────────────────────────

export const listReviewsQuerySchema = z.object({
  page: z.coerce.number().int().positive().optional(),
  limit: z.coerce.number().int().positive().max(100).optional(),
  status: z.enum(['all', 'pending', 'approved', 'rejected', 'spam', 'hidden']).optional(),
  product_id: z.coerce.number().int().positive().optional(),
  rating: z.coerce.number().int().min(1).max(5).optional(),
  flagged: z.coerce.boolean().optional(),
  reported: z.coerce.boolean().optional(),
  q: z.string().trim().max(120).optional(),
  sort: z.enum(['newest', 'oldest', 'rating_high', 'rating_low', 'helpful']).optional(),
});

export const reviewIdParamSchema = z.object({
  id: z.coerce.number().int().positive(),
});

export const changeStatusSchema = z.object({
  status: z.enum(['approved', 'rejected', 'spam', 'hidden']),
  note: z.string().trim().max(500).optional(),
  // Required for a rejection, checked in the service so the message can explain
  // why rather than reading as a generic field error.
  reason: z.string().trim().max(255).optional(),
});

export const replySchema = z.object({
  body: z.string().trim().min(2, 'Write a reply.').max(2000),
  display_name: z.string().trim().max(120).optional(),
});

// ── storefront ───────────────────────────────────────────────────────────────

export const productSlugParamSchema = z.object({
  slug: z.string().trim().min(1).max(160),
});

export const publicListQuerySchema = z.object({
  page: z.coerce.number().int().positive().optional(),
  limit: z.coerce.number().int().positive().max(50).optional(),
  sort: z.enum(['newest', 'oldest', 'rating_high', 'rating_low', 'helpful']).optional(),
});

/** The mobile number the order was placed with, in the shop's country. Same rule as checkout. */
const phone = shopPhone('Enter the mobile number from the order.');

export const eligibilityQuerySchema = z.object({
  order_number: z.string().trim().min(3).max(40),
  phone,
});

export const submitReviewSchema = z.object({
  order_number: z.string().trim().min(3, 'Enter the order number from your confirmation.').max(40),
  phone,
  rating: z.coerce.number().int().min(1, 'Choose a rating.').max(5),
  title: z.string().trim().max(200).nullish(),
  body: z.string().trim().max(5000).nullish(),
  author_name: z.string().trim().min(2, 'Tell us what to call you.').max(120),
  author_location: z.string().trim().max(120).nullish(),
  author_email: z.string().trim().toLowerCase().email('Enter a valid email address.').max(191).nullish(),
  age_range: z.enum(['under_18', '18_24', '25_34', '35_44', '45_54', '55_plus']).nullish(),
  usage_duration: z
    .enum(['less_than_week', 'one_to_four_weeks', 'one_to_three_months', 'three_months_plus'])
    .nullish(),
  would_recommend: z.boolean().nullish(),
});
