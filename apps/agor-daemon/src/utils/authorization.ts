/**
 * Authorization utilities for Feathers services and custom routes.
 */

import { Forbidden, NotAuthenticated } from '@agor/core/feathers';
import type { AuthenticatedParams, HookContext } from '@agor/core/types';

export type Role = 'owner' | 'admin' | 'member' | 'viewer';

const ROLE_RANK: Record<Role, number> = {
  viewer: 0,
  member: 1,
  admin: 2,
  owner: 3,
};

/**
 * Determine whether a role meets or exceeds the minimum role requirement.
 */
function hasMinimumRole(userRole: string | undefined, minimumRole: Role): boolean {
  if (!userRole) {
    return minimumRole === 'viewer';
  }

  const normalizedRole = (userRole.toLowerCase() as Role) || 'viewer';
  const userRank = ROLE_RANK[normalizedRole] ?? ROLE_RANK.viewer;
  const requiredRank = ROLE_RANK[minimumRole];
  return userRank >= requiredRank;
}

/**
 * Ensure the request is authenticated and has the minimum required role.
 *
 * Internal calls (params.provider is falsy) bypass authorization checks.
 */
export function ensureMinimumRole(
  params: AuthenticatedParams | undefined,
  minimumRole: Role,
  action: string = 'perform this action'
): void {
  // Skip authorization for internal calls (daemon-to-daemon)
  if (!params?.provider) {
    return;
  }

  if (!params.user) {
    throw new NotAuthenticated('Authentication required');
  }

  if (!hasMinimumRole(params.user.role, minimumRole)) {
    throw new Forbidden(`You need ${minimumRole} access to ${action}`);
  }
}

/**
 * Feathers hook factory that enforces a minimum role for the given action.
 */
export function requireMinimumRole(minimumRole: Role, action?: string) {
  return (context: HookContext) => {
    ensureMinimumRole(context.params, minimumRole, action);
    return context;
  };
}

/**
 * Helper to register authenticated custom routes with hooks.
 *
 * This utility reduces boilerplate when creating custom Feathers routes that require authentication.
 * It automatically applies requireAuth and requireMinimumRole hooks to specified methods.
 *
 * @param app - Feathers application instance
 * @param path - Route path (can include params like '/sessions/:id/spawn')
 * @param service - Service implementation object with method handlers
 * @param authConfig - Object mapping method names to required roles and action descriptions
 * @param requireAuth - The requireAuth hook from Feathers authentication
 *
 * @example
 * registerAuthenticatedRoute(
 *   app,
 *   '/sessions/:id/spawn',
 *   {
 *     async create(data, params) {
 *       // handler implementation
 *     }
 *   },
 *   {
 *     create: { role: 'member', action: 'spawn sessions' }
 *   },
 *   requireAuth
 * );
 */
export function registerAuthenticatedRoute(
  // biome-ignore lint/suspicious/noExplicitAny: Feathers app type is complex and varies
  app: any,
  path: string,
  // biome-ignore lint/suspicious/noExplicitAny: Service can have various method signatures
  service: any,
  authConfig: Record<string, { role: Role; action: string }>,
  // biome-ignore lint/suspicious/noExplicitAny: Hook type from Feathers is complex
  requireAuth: any
): void {
  // Register the service
  app.use(path, service);

  // Build hooks object
  const hooks: Record<
    string,
    Array<(context: HookContext) => HookContext | Promise<HookContext>>
  > = {};

  for (const [method, config] of Object.entries(authConfig)) {
    hooks[method] = [requireAuth, requireMinimumRole(config.role, config.action)];
  }

  // Apply hooks
  app.service(path).hooks({
    before: hooks,
  });
}
