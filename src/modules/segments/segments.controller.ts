import { Request, Response } from 'express'
import { asyncHandler } from '../../core/asyncHandler'
import * as service from './segments.service'

// Extend Request type to include user
interface AuthRequest extends Request {
  user?: {
    id: number
    email: string
    is_super_admin: boolean
    roles?: Array<{ id: number; name: string }>
  }
}

// Segments
export const listSegments = asyncHandler(async (req: AuthRequest, res: Response) => {
  const { segment_type, search } = req.query
  const segments = await service.listSegments({
    segment_type: segment_type as string,
    search: search as string,
  })
  res.json({ segments })
})

export const getSegment = asyncHandler(async (req: AuthRequest, res: Response) => {
  const id = parseInt(req.params.id, 10)
  const segment = await service.getSegment(id)
  if (!segment) {
    return res.status(404).json({ error: 'Segment not found' })
  }
  res.json({ segment })
})

export const createSegment = asyncHandler(async (req: AuthRequest, res: Response) => {
  const adminId = req.user!.id
  const result = await service.createSegment(req.body, adminId)
  res.status(201).json(result)
})

export const updateSegment = asyncHandler(async (req: AuthRequest, res: Response) => {
  const id = parseInt(req.params.id, 10)
  await service.updateSegment(id, req.body)
  res.json({ success: true })
})

export const deleteSegment = asyncHandler(async (req: AuthRequest, res: Response) => {
  const id = parseInt(req.params.id, 10)
  await service.deleteSegment(id)
  res.json({ success: true })
})

export const getSegmentMembers = asyncHandler(async (req: AuthRequest, res: Response) => {
  const id = parseInt(req.params.id, 10)
  const page = parseInt(req.query.page as string, 10) || 1
  const limit = parseInt(req.query.limit as string, 10) || 50
  const result = await service.getSegmentMembers(id, page, limit)
  res.json(result)
})

export const addMemberToSegment = asyncHandler(async (req: AuthRequest, res: Response) => {
  const segmentId = parseInt(req.params.id, 10)
  const { customer_id } = req.body
  const adminId = req.user!.id
  await service.addCustomerToSegment(segmentId, customer_id, adminId)
  res.json({ success: true })
})

export const removeMemberFromSegment = asyncHandler(async (req: AuthRequest, res: Response) => {
  const segmentId = parseInt(req.params.id, 10)
  const customerId = parseInt(req.params.customerId, 10)
  await service.removeCustomerFromSegment(segmentId, customerId)
  res.json({ success: true })
})

// Tags
export const listTags = asyncHandler(async (req: AuthRequest, res: Response) => {
  const tags = await service.listTags()
  res.json({ tags })
})

export const createTag = asyncHandler(async (req: AuthRequest, res: Response) => {
  const result = await service.createTag(req.body)
  res.status(201).json(result)
})

export const updateTag = asyncHandler(async (req: AuthRequest, res: Response) => {
  const id = parseInt(req.params.id, 10)
  await service.updateTag(id, req.body)
  res.json({ success: true })
})

export const deleteTag = asyncHandler(async (req: AuthRequest, res: Response) => {
  const id = parseInt(req.params.id, 10)
  await service.deleteTag(id)
  res.json({ success: true })
})

export const assignTag = asyncHandler(async (req: AuthRequest, res: Response) => {
  const { tag_id, customer_id } = req.body
  const adminId = req.user!.id
  await service.assignTagToCustomer(tag_id, customer_id, adminId)
  res.json({ success: true })
})

export const removeTag = asyncHandler(async (req: AuthRequest, res: Response) => {
  const { tag_id, customer_id } = req.body
  await service.removeTagFromCustomer(tag_id, customer_id)
  res.json({ success: true })
})

export const getCustomerTags = asyncHandler(async (req: AuthRequest, res: Response) => {
  const customerId = parseInt(req.params.customerId, 10)
  const tags = await service.getCustomerTags(customerId)
  res.json({ tags })
})
