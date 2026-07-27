/**
 * Authorization utilities for Feathers services and custom routes.
 */

import { Forbidden, NotAuthenticated } from '@agor/core/feathers';
import type { AuthenticatedParams, HookContext, UserRole } from '@agor/core/types';
import { hasMinimumRole, ROLES } from '@agor/core/types';
import { executorRuntimeScopeGuard } from '../auth/executor-runtime-scope.js';

export type Role = UserRole;

/**
 * Ensure the request is authenticated and has the minimum required role.
 *
 * Internal calls (params.provider is falsy) bypass authorization checks.
 * Service accounts (_isServiceAccount) also bypass authorization checks.
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

  // Skip authorization for service accounts (executor, etc.)
  // biome-ignore lint/suspicious/noExplicitAny: Service account flag is added dynamically by auth strategy
  if ((params.user as any)._isServiceAccount === true) {
    return;
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
 * Fields that contain executable commands or environment configuration.
 *
 * Repos store templates in `environment` (v2 source of truth) or the legacy
 * `environment_config` view; branches store resolved values as top-level
 * fields plus the currently-rendered `environment_variant` name. All of these
 * execute as (or select) commands that run as the system user, so only admins
 * may write them.
 */
const ENV_COMMAND_FIELDS = [
  'environment', // Repo-level: v2 named variants (source of truth)
  'environment_config', // Repo-level: legacy v1 view (still guarded)
  'environment_variant', // Branch-level: selected variant name
  'start_command', // Branch-level: resolved commands
  'stop_command',
  'nuke_command',
  'logs_command',
  'health_check_url',
  'app_url',
];

/**
 * Feathers hook that requires admin role when environment command fields are being modified.
 *
 * Environment commands execute as the system user, so only admins/superadmins
 * may set or change them. Works for both repo-level (environment_config) and
 * branch-level (start_command, stop_command, etc.) fields.
 */
export function requireAdminForEnvConfig() {
  return (context: HookContext) => {
    // biome-ignore lint/suspicious/noExplicitAny: context.data shape varies per service
    const data = context.data as any;

    // Check both single objects and array payloads (bulk create)
    const items = Array.isArray(data) ? data : [data];
    const hasEnvConfig = items.some((item: Record<string, unknown>) =>
      ENV_COMMAND_FIELDS.some((field) => item?.[field] != null)
    );
    if (!hasEnvConfig) {
      return context;
    }

    // Internal calls and service accounts bypass (handled by ensureMinimumRole)
    ensureMinimumRole(
      context.params,
      ROLES.ADMIN,
      'modify environment commands (up_command, down_command, etc.)'
    );

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
 *     create: { role: ROLES.MEMBER, action: 'spawn sessions' }
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
  requireAuth: any,
  options: {
    around?: Array<(context: HookContext, next: () => Promise<void>) => Promise<void>>;
  } = {}
): void {
  // Register the service
  app.use(path, service);

  // Build hooks object
  const hooks: Record<
    string,
    Array<(context: HookContext) => HookContext | Promise<HookContext>>
  > = {};

  for (const [method, config] of Object.entries(authConfig)) {
    hooks[method] = [
      requireAuth,
      executorRuntimeScopeGuard(),
      requireMinimumRole(config.role, config.action),
    ];
  }

  // Apply hooks
  app.service(path).hooks({
    ...(options.around ? { around: { all: options.around } } : {}),
    before: hooks,
  });
}
