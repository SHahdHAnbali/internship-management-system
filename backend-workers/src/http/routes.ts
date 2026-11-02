import type { Context } from 'hono';
import type { AppEnv } from '../context';
import type { UserRole } from '../domain/roles';
import { parseGuid } from '../domain/uuid';

/**
 * Who may call an endpoint. Like the C# API's fallback policy, every endpoint requires a signed-in user unless it is
 * explicitly `anonymous` ([AllowAnonymous]); a role policy ([Authorize(Policy = …)]) requires that exact role.
 */
export type Policy = 'anonymous' | 'authenticated' | UserRole;

export interface Route {
  method: 'GET' | 'POST' | 'PUT' | 'DELETE';
  /** Lower-case path; `:id` segments only match a GUID (the C# `{id:guid}` route constraint). */
  path: string;
  policy: Policy;
  /** The trainee sign-in rate limit ([EnableRateLimiting]). */
  rateLimited?: boolean;
  handle: (c: Context<AppEnv>) => Promise<Response>;
}

/** Request path for matching: ASP.NET routing ignores case and a trailing slash. */
export function routingPath(pathname: string): string {
  const lower = pathname.toLowerCase();
  return lower.length > 1 && lower.endsWith('/') ? lower.slice(0, -1) : lower;
}

/** True when `path` matches the route template, including the GUID constraint on `:id`. */
export function matchesTemplate(template: string, path: string): boolean {
  const expected = template.split('/');
  const actual = path.split('/');
  return (
    expected.length === actual.length &&
    expected.every((segment, i) => (segment === ':id' ? safeDecode(actual[i]!) !== null : segment === actual[i]))
  );
}

function safeDecode(segment: string): string | null {
  try {
    return parseGuid(decodeURIComponent(segment));
  } catch {
    return null;
  }
}

/** The `:id` route value as a canonical GUID (already validated by the route match). */
export function routeId(c: Context<AppEnv>): string {
  return parseGuid(c.req.param('id') ?? '')!;
}
