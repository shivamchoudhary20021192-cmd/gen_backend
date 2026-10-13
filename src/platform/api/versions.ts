import type { NextFunction, Request, Response } from 'express';

/**
 * Admin API versions, date-named like Shopify's.
 *
 * A version is a promise: nothing in a released version's request or response
 * shapes changes incompatibly. Breaking changes ship in the next version, and
 * the old one is supported for at least twelve months after its successor.
 *
 * Requests name a version in the path (/admin/api/2026-10/products). `v1` is
 * the name the existing admin frontend already uses and stays an alias for
 * the first dated version. An unknown or retired version falls forward to the
 * oldest supported one — Shopify's behaviour — and says so in a header, so a
 * client pinned to a dead version keeps working and can see why.
 */

export const API_VERSIONS = ['2026-10'] as const;
export const LATEST_API_VERSION = API_VERSIONS[API_VERSIONS.length - 1];
const ALIASES: Record<string, string> = { v1: '2026-10' };

export function resolveApiVersion(requested: string | undefined): { version: string; fellForward: boolean } {
  if (!requested) return { version: LATEST_API_VERSION, fellForward: false };
  const aliased = ALIASES[requested] ?? requested;
  if ((API_VERSIONS as readonly string[]).includes(aliased)) return { version: aliased, fellForward: false };
  return { version: API_VERSIONS[0], fellForward: true };
}

export function isSupportedApiVersion(version: string): boolean {
  return (API_VERSIONS as readonly string[]).includes(ALIASES[version] ?? version);
}

/** Mounted as `/admin/api/:version`. Sets req.apiVersion and the response header. */
export function apiVersion(req: Request, res: Response, next: NextFunction): void {
  const { version, fellForward } = resolveApiVersion(req.params.version);
  req.apiVersion = version;
  res.setHeader('X-Veylog-Api-Version', version);
  if (fellForward) res.setHeader('X-Veylog-Api-Version-Warning', `Version ${req.params.version} is not supported; served ${version}.`);
  next();
}
