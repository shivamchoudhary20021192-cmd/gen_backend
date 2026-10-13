/**
 * Service layer for FAQs module
 * Handles business logic, validation, and orchestration
 */

import { ApiError } from '../../../core/ApiError'
import { faqGroupsRepository, faqsRepository } from './faqs.repository'
import { slugify } from '../../../core/slug'
import type {
  FAQGroup,
  FAQ,
  FAQWithRelations,
  CreateFAQGroupDto,
  UpdateFAQGroupDto,
  CreateFAQDto,
  UpdateFAQDto,
  ListFAQsParams,
  ListFAQGroupsParams,
} from './faqs.types'

// ══════════════════════════════════════════════════════════════════════════════
// FAQ GROUPS SERVICE
// ══════════════════════════════════════════════════════════════════════════════

export const faqGroupsService = {
  async list(params: ListFAQGroupsParams) {
    return faqGroupsRepository.list(params)
  },

  async getById(id: number): Promise<FAQGroup> {
    const group = await faqGroupsRepository.getById(id)
    if (!group) throw new ApiError(404, 'NOT_FOUND', 'FAQ group not found')
    return group
  },

  async getBySlug(slug: string): Promise<FAQGroup> {
    const group = await faqGroupsRepository.getBySlug(slug)
    if (!group) throw new ApiError(404, 'NOT_FOUND', 'FAQ group not found')
    return group
  },

  async create(data: CreateFAQGroupDto): Promise<FAQGroup> {
    if (!data.name?.trim()) throw ApiError.badRequest('Group name is required')

    const slug = data.slug?.trim() || slugify(data.name)
    const existing = await faqGroupsRepository.getBySlug(slug)
    if (existing) throw ApiError.conflict('A group with this slug already exists')

    return faqGroupsRepository.create({ ...data, slug, name: data.name.trim() })
  },

  async update(id: number, data: UpdateFAQGroupDto): Promise<FAQGroup> {
    const existing = await faqGroupsRepository.getById(id)
    if (!existing) throw new ApiError(404, 'NOT_FOUND', 'FAQ group not found')

    if (data.name !== undefined && !data.name.trim()) {
      throw ApiError.badRequest('Group name cannot be empty')
    }

    if (data.slug && data.slug !== existing.slug) {
      const slugExists = await faqGroupsRepository.getBySlug(data.slug)
      if (slugExists) throw ApiError.conflict('A group with this slug already exists')
    }

    const updateData = { ...data }
    if (updateData.name) updateData.name = updateData.name.trim()

    return faqGroupsRepository.update(id, updateData)
  },

  async delete(id: number): Promise<void> {
    const existing = await faqGroupsRepository.getById(id)
    if (!existing) throw new ApiError(404, 'NOT_FOUND', 'FAQ group not found')

    const faqs = await faqsRepository.list({ group_id: id, limit: 1 })
    if (faqs.data.length > 0) {
      throw ApiError.badRequest('Cannot delete group with FAQs. Please reassign or delete FAQs first.')
    }

    await faqGroupsRepository.delete(id)
  },
}

// ══════════════════════════════════════════════════════════════════════════════
// FAQS SERVICE
// ══════════════════════════════════════════════════════════════════════════════

export const faqsService = {
  async list(params: ListFAQsParams) {
    return faqsRepository.list(params)
  },

  async getById(id: number): Promise<FAQWithRelations> {
    const faq = await faqsRepository.getById(id)
    if (!faq) throw new ApiError(404, 'NOT_FOUND', 'FAQ not found')
    return faq
  },

  async create(data: CreateFAQDto): Promise<FAQ> {
    if (!data.question?.trim()) throw ApiError.badRequest('Question is required')
    if (!data.answer?.trim()) throw ApiError.badRequest('Answer is required')
    if (data.question.trim().length > 500) {
      throw ApiError.badRequest('Question cannot exceed 500 characters')
    }

    if (data.group_id) {
      const groupExists = await faqGroupsRepository.getById(data.group_id)
      if (!groupExists) throw new ApiError(404, 'NOT_FOUND', 'FAQ group not found')
    }

    if (data.entity_type && !data.entity_id) {
      throw ApiError.badRequest('entity_id is required when entity_type is provided')
    }
    if (data.entity_id && !data.entity_type) {
      throw ApiError.badRequest('entity_type is required when entity_id is provided')
    }

    return faqsRepository.create({
      ...data,
      question: data.question.trim(),
      answer: data.answer.trim(),
    })
  },

  async update(id: number, data: UpdateFAQDto): Promise<FAQ> {
    const existing = await faqsRepository.getById(id)
    if (!existing) throw new ApiError(404, 'NOT_FOUND', 'FAQ not found')

    if (data.question !== undefined) {
      if (!data.question.trim()) throw ApiError.badRequest('Question cannot be empty')
      if (data.question.trim().length > 500) {
        throw ApiError.badRequest('Question cannot exceed 500 characters')
      }
    }

    if (data.answer !== undefined && !data.answer.trim()) {
      throw ApiError.badRequest('Answer cannot be empty')
    }

    if (data.group_id) {
      const groupExists = await faqGroupsRepository.getById(data.group_id)
      if (!groupExists) throw new ApiError(404, 'NOT_FOUND', 'FAQ group not found')
    }

    if (data.entity_type !== undefined && data.entity_id === undefined) {
      throw ApiError.badRequest('entity_id is required when entity_type is provided')
    }
    if (data.entity_id !== undefined && data.entity_type === undefined) {
      throw ApiError.badRequest('entity_type is required when entity_id is provided')
    }

    const updateData = { ...data }
    if (updateData.question) updateData.question = updateData.question.trim()
    if (updateData.answer) updateData.answer = updateData.answer.trim()

    return faqsRepository.update(id, updateData)
  },

  async delete(id: number): Promise<void> {
    const existing = await faqsRepository.getById(id)
    if (!existing) throw new ApiError(404, 'NOT_FOUND', 'FAQ not found')
    await faqsRepository.delete(id)
  },

  async markHelpful(id: number): Promise<void> {
    const existing = await faqsRepository.getById(id)
    if (!existing) throw new ApiError(404, 'NOT_FOUND', 'FAQ not found')
    await faqsRepository.incrementHelpful(id)
  },

  async publish(id: number): Promise<FAQ> {
    return this.update(id, { is_published: true })
  },

  async unpublish(id: number): Promise<FAQ> {
    return this.update(id, { is_published: false })
  },

  async bulkUpdateSortOrder(updates: Array<{ id: number; sort_order: number }>): Promise<void> {
    if (!updates || updates.length === 0) {
      throw ApiError.badRequest('No updates provided')
    }

    // Validate all IDs exist
    for (const update of updates) {
      const exists = await faqsRepository.getById(update.id)
      if (!exists) throw new ApiError(404, 'NOT_FOUND', `FAQ ${update.id} not found`)
    }

    await faqsRepository.bulkUpdateSortOrder(updates)
  },
}
