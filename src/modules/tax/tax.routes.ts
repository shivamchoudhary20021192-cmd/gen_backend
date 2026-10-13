import { Router, type Request, type Response } from 'express';
import { z } from 'zod';
import { ApiError } from '../../core/ApiError';
import { asyncHandler } from '../../core/asyncHandler';
import { authenticate } from '../../middleware/authenticate';
import { clientIp } from '../../middleware/requestContext';
import { requirePermission } from '../../middleware/requirePermission';
import { validate } from '../../middleware/validate';
import { regionCode } from '../../platform/geo/postalCodes';
import { tenancy } from '../../platform/tenancy/context';
import { taxAdminService } from './tax.service';

/** Settings → Taxes, at /admin/api/:version/tax. */
export const taxRoutes = Router();
taxRoutes.use(authenticate);

function who(req: Request) {
  return { id: req.admin!.id, email: req.admin!.email };
}

function meta(req: Request) {
  return { ip: clientIp(req), userAgent: req.header('User-Agent')?.slice(0, 255) ?? null };
}

const id = z.object({ id: z.coerce.number().int().positive() });
const percent = z.coerce.number().min(0).max(100);

const classBody = z.object({
  code: z.string().trim().toUpperCase().regex(/^[A-Z0-9_]+$/, 'Use letters, numbers and underscores.').min(2).max(40),
  name: z.string().trim().min(1).max(120),
  rate: percent,
  inclusive: z.boolean(),
  exempt: z.boolean().default(false),
  hsn_code: z.string().trim().max(12).nullish(),
  is_default: z.boolean().default(false),
  is_active: z.boolean().default(true),
});

/** API names onto the table's (which still say gst_rate from the single-shop days). */
function classColumns(body: Partial<z.infer<typeof classBody>>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (body.code !== undefined) out.code = body.code;
  if (body.name !== undefined) out.name = body.name;
  if (body.rate !== undefined) out.gst_rate = body.rate;
  if (body.inclusive !== undefined) out.is_inclusive = body.inclusive ? 1 : 0;
  if (body.exempt !== undefined) out.is_exempt = body.exempt ? 1 : 0;
  if (body.hsn_code !== undefined) out.hsn_code = body.hsn_code ?? null;
  if (body.is_active !== undefined) out.is_active = body.is_active ? 1 : 0;
  if (body.is_default !== undefined) out.is_default = body.is_default;
  return out;
}

const registrationBody = z.object({
  country_code: z.string().trim().length(2).transform((value) => value.toUpperCase()).optional(),
  // Omitted: the whole country (Canada's federal GST).
  region_code: regionCode().nullish(),
  name: z.string().trim().min(2).max(120),
  registration_number: z.string().trim().max(60).nullish(),
  rate: percent,
  shipping_taxable: z.boolean().default(false),
  is_active: z.boolean().default(true),
});

function registrationColumns(body: Partial<z.infer<typeof registrationBody>>, creating: boolean): Record<string, unknown> {
  const shopCountry = tenancy.current().countryCode;
  const country = body.country_code ?? (creating ? shopCountry : undefined);
  // Orders are delivered within the store's own country; a registration
  // anywhere else would never apply, so it is refused rather than stored.
  if (country !== undefined && country !== shopCountry) {
    throw ApiError.validation({ country_code: [`This store sells within ${shopCountry}.`] });
  }
  const out: Record<string, unknown> = {};
  if (country !== undefined) out.country_code = country;
  if (body.region_code !== undefined) out.region_code = body.region_code ?? null;
  if (body.name !== undefined) out.name = body.name;
  if (body.registration_number !== undefined) out.registration_number = body.registration_number ?? null;
  if (body.rate !== undefined) out.rate = body.rate;
  if (body.shipping_taxable !== undefined) out.shipping_taxable = body.shipping_taxable ? 1 : 0;
  if (body.is_active !== undefined) out.is_active = body.is_active ? 1 : 0;
  return out;
}

taxRoutes.get(
  '/',
  requirePermission('settings.view'),
  asyncHandler(async (_req: Request, res: Response) => {
    res.json(await taxAdminService.overview());
  }),
);

taxRoutes.put(
  '/settings',
  requirePermission('settings.manage'),
  validate({ body: z.object({ shipping_taxable: z.boolean().optional() }) }),
  asyncHandler(async (req: Request, res: Response) => {
    res.json(await taxAdminService.updateSettings(req.body, who(req), meta(req)));
  }),
);

taxRoutes.post(
  '/classes',
  requirePermission('settings.manage'),
  validate({ body: classBody }),
  asyncHandler(async (req: Request, res: Response) => {
    res.status(201).json(await taxAdminService.createClass(classColumns(req.body), who(req), meta(req)));
  }),
);

taxRoutes.patch(
  '/classes/:id',
  requirePermission('settings.manage'),
  validate({ params: id, body: classBody.partial() }),
  asyncHandler(async (req: Request, res: Response) => {
    res.json(await taxAdminService.updateClass(Number(req.params.id), classColumns(req.body), who(req), meta(req)));
  }),
);

taxRoutes.post(
  '/registrations',
  requirePermission('settings.manage'),
  validate({ body: registrationBody }),
  asyncHandler(async (req: Request, res: Response) => {
    res.status(201).json(await taxAdminService.createRegistration(registrationColumns(req.body, true), who(req), meta(req)));
  }),
);

taxRoutes.patch(
  '/registrations/:id',
  requirePermission('settings.manage'),
  validate({ params: id, body: registrationBody.partial() }),
  asyncHandler(async (req: Request, res: Response) => {
    res.json(await taxAdminService.updateRegistration(Number(req.params.id), registrationColumns(req.body, false), who(req), meta(req)));
  }),
);

taxRoutes.delete(
  '/registrations/:id',
  requirePermission('settings.manage'),
  validate({ params: id }),
  asyncHandler(async (req: Request, res: Response) => {
    res.json(await taxAdminService.deleteRegistration(Number(req.params.id), who(req), meta(req)));
  }),
);

/** What a customer would pay at an address, for checking the registrations. */
taxRoutes.post(
  '/preview',
  requirePermission('settings.view'),
  validate({
    body: z.object({
      region: regionCode().nullish(),
      postal_code: z.string().trim().max(16).nullish(),
      amount: z.coerce.number().min(0).max(10_000_000),
      shipping: z.coerce.number().min(0).max(1_000_000).default(0),
      exempt: z.boolean().default(false),
      tax_class_id: z.coerce.number().int().positive().nullish(),
    }),
  }),
  asyncHandler(async (req: Request, res: Response) => {
    const body = req.body as { region?: string | null; postal_code?: string | null; amount: number; shipping: number; exempt: boolean; tax_class_id?: number | null };
    res.json(
      await taxAdminService.preview({
        region: body.region ?? null,
        postal_code: body.postal_code ?? null,
        amount: body.amount,
        shipping: body.shipping,
        exempt: body.exempt,
        tax_class_id: body.tax_class_id ?? null,
      }),
    );
  }),
);
