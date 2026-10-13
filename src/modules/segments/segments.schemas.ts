import { z } from 'zod'

export const createSegmentSchema = z.object({
  name: z.string().min(1).max(120),
  description: z.string().optional(),
  segment_type: z.enum(['manual', 'auto', 'imported']),
  rules: z.any().optional(),
  rules_operator: z.enum(['all', 'any']).optional(),
  color: z.string().regex(/^#[0-9A-Fa-f]{6}$/).optional(),
  icon: z.string().max(40).optional(),
})

export const updateSegmentSchema = z.object({
  name: z.string().min(1).max(120).optional(),
  description: z.string().optional(),
  rules: z.any().optional(),
  rules_operator: z.enum(['all', 'any']).optional(),
  color: z.string().regex(/^#[0-9A-Fa-f]{6}$/).optional(),
  icon: z.string().max(40).optional(),
})

export const addMemberSchema = z.object({
  customer_id: z.number().int().positive(),
})

export const createTagSchema = z.object({
  name: z.string().min(1).max(60),
  color: z.string().regex(/^#[0-9A-Fa-f]{6}$/).optional(),
  description: z.string().max(255).optional(),
})

export const updateTagSchema = z.object({
  name: z.string().min(1).max(60).optional(),
  color: z.string().regex(/^#[0-9A-Fa-f]{6}$/).optional(),
  description: z.string().max(255).optional(),
})

export const assignTagSchema = z.object({
  tag_id: z.number().int().positive(),
  customer_id: z.number().int().positive(),
})
