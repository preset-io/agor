/**
 * Authorization utilities for Feathers services and custom routes.
 */

import type { ManagedEnvsMinimumRole } from '@agor/core/config';
import { Forbidden, NotAuthenticated } from '@agor/core/feathers';
import type { AuthenticatedParams, HookContext, UserRole } from '@agor/core/types';
import { hasMinimumRole, ROLES } from '@agor/core/types';

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
 * Default minimum role for triggering managed environment commands.
 * Keep in sync with `AgorExecutionSettings.managed_envs_minimum_role`.
 */
const DEFAULT_MANAGED_ENVS_MINIMUM_ROLE: UserRole = ROLES.MEMBER;

/**
 * Enforce the `execution.managed_envs_minimum_role` config on managed
 * environment triggers (start/stop/nuke/logs).
 *
 * - `'none'` is a kill switch: throws Forbidden regardless of caller role.
 * - Otherwise delegates to `ensureMinimumRole`, so internal calls and service
 *   accounts bypass (same semantics as other role gates).
 *
 * Canonical enforcement point — called from the service layer so that REST,
 * WebSocket, *and* MCP tool invocations all pass through the same gate.
 */
export function ensureCanTriggerManagedEnv(
  minimumRole: ManagedEnvsMinimumRole | undefined,
  params: AuthenticatedParams | undefined,
  action: string
): void {
  const value = minimumRole ?? DEFAULT_MANAGED_ENVS_MINIMUM_ROLE;

  if (value === 'none') {
    // Internal calls still bypass (daemon-initiated health loops, etc.)
    if (!params?.provider) return;
    throw new Forbidden(
      `Managed environments are disabled (execution.managed_envs_minimum_role: 'none'); cannot ${action}`
    );
  }

  ensureMinimumRole(params, value, action);
}

/**
 * Fields that contain executable commands or environment configuration.
 * Repos store templates in `environment_config`; worktrees store resolved values
 * as top-level fields. Both execute as the system user and require admin access.
 */
const ENV_COMMAND_FIELDS = [
  'environment_config', // Repo-level: template object
  'start_command', // Worktree-level: resolved commands
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
 * worktree-level (start_command, stop_command, etc.) fields.
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
