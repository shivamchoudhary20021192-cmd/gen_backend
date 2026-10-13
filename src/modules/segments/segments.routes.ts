import { Router } from 'express'
import { authenticate } from '../../middleware/authenticate'
import { requirePermission } from '../../middleware/requirePermission'
import { validate } from '../../middleware/validate'
import * as ctrl from './segments.controller'
import * as schemas from './segments.schemas'

const router = Router()

// Mounted at the API root, because its paths span /segments, /tags and
// /customers/:customerId/tags. The guard is therefore scoped to those paths:
// a bare router.use() would demand customers.view of every request that passes
// through on its way to a later router.
// All of them require authentication and the customers.view permission.
router.use(['/segments', '/tags', '/customers/:customerId/tags'], authenticate, requirePermission('customers.view'))

// Segments
router.get('/segments', ctrl.listSegments)
router.get('/segments/:id', ctrl.getSegment)
router.post('/segments', validate({ body: schemas.createSegmentSchema }), ctrl.createSegment)
router.patch('/segments/:id', validate({ body: schemas.updateSegmentSchema }), ctrl.updateSegment)
router.delete('/segments/:id', ctrl.deleteSegment)

// Segment members
router.get('/segments/:id/members', ctrl.getSegmentMembers)
router.post('/segments/:id/members', validate({ body: schemas.addMemberSchema }), ctrl.addMemberToSegment)
router.delete('/segments/:id/members/:customerId', ctrl.removeMemberFromSegment)

// Tags
router.get('/tags', ctrl.listTags)
router.post('/tags', validate({ body: schemas.createTagSchema }), ctrl.createTag)
router.patch('/tags/:id', validate({ body: schemas.updateTagSchema }), ctrl.updateTag)
router.delete('/tags/:id', ctrl.deleteTag)

// Customer tags
router.get('/customers/:customerId/tags', ctrl.getCustomerTags)
router.post('/tags/assign', validate({ body: schemas.assignTagSchema }), ctrl.assignTag)
router.post('/tags/remove', validate({ body: schemas.assignTagSchema }), ctrl.removeTag)

export default router
