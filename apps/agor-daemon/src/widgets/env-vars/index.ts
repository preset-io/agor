/**
 * env_vars widget — registry entry and registration.
 *
 * Concrete widget type: agent renders an inline form asking the user for one
 * or more env vars (e.g. `HUBSPOT_API_KEY`). The values flow browser → daemon
 * via `POST /widgets/:widget_id/submit` (NOT through the agent context) and
 * land in the session creator's `users.data.env_vars` via the existing users
 * service — encryption + blocklist + validation all reused.
 *
 * See §4 + §7 Part 2 of `docs/internal/in-conversation-widgets-design-2026-05-19.md`.
 */

import { ENV_VAR_CONSTRAINTS, isEnvVarAllowed, validateEnvVar } from '@agor/core/config';
import type { UserID } from '@agor/core/types';
import { z } from 'zod';
import { registerWidget, type WidgetRegistryEntry, type WidgetSubmitCtx } from '../registry.js';

/** Mirror of the regex used by the users service. */
const ENV_VAR_NAME_REGEX = ENV_VAR_CONSTRAINTS.NAME_PATTERN;

/**
 * Agent-provided params (validated when the MCP tool fires).
 * Stored at `metadata.widget.params` on the widget message row.
 */
export const envVarsParamsSchema = z.object({
  names: z
    .array(z.string().regex(ENV_VAR_NAME_REGEX))
    .min(1)
    .max(10)
    .describe('UPPER_SNAKE env var names (same validation as User Settings).'),
  reason: z
    .string()
    .min(1)
    .max(500)
    .describe('Short explanation shown to the user — why these are needed.'),
  instructions: z
    .string()
    .max(2000)
    .optional()
    .describe('Optional markdown with extra context (e.g. where to obtain the key).'),
  default_scope: z
    .enum(['global', 'session'])
    .default('global')
    .describe('Suggested scope for the values. User can override in the form.'),
  auto_resume: z
    .boolean()
    .default(true)
    .describe(
      'When true (default), a system-authored prompt is auto-queued back into the agent on submit/dismiss.'
    ),
});

export type EnvVarsParams = z.infer<typeof envVarsParamsSchema>;

/**
 * Browser → daemon submit payload. Direct HTTP, never reaches the agent.
 */
export const envVarsSubmitSchema = z.object({
  values: z
    .record(
      z.string().regex(ENV_VAR_NAME_REGEX),
      z.string().min(1).max(ENV_VAR_CONSTRAINTS.MAX_VALUE_LENGTH)
    )
    .refine((v) => Object.keys(v).length >= 1 && Object.keys(v).length <= 10, {
      message: 'Must submit between 1 and 10 env vars',
    }),
  scope: z.enum(['global', 'session']),
});

export type EnvVarsSubmit = z.infer<typeof envVarsSubmitSchema>;

/**
 * Result metadata: ONLY contains the names that were submitted + the scope.
 * NEVER includes values. This is the data that flows back into the agent
 * context via the auto-resume prompt.
 */
export interface EnvVarsResultMeta {
  names_submitted: string[];
  scope: 'global' | 'session';
}

/**
 * Side-effect: persist the submitted values via the users service. Encryption,
 * blocklist, regex, and value-length checks all live inside that service —
 * we deliberately do NOT reimplement them here.
 */
async function applyEnvVarsSubmit(ctx: WidgetSubmitCtx, submit: EnvVarsSubmit): Promise<void> {
  // Belt-and-braces: re-validate names against the same regex+blocklist
  // the users service uses, surfacing a single combined error if anything
  // fails. The users service would reject the same way, but doing it here
  // up-front gives us a clearer error per name without partial writes.
  for (const name of Object.keys(submit.values)) {
    if (!isEnvVarAllowed(name)) {
      throw new Error(`Cannot set environment variable "${name}": blocked by allow-list`);
    }
    const errors = validateEnvVar(name, submit.values[name]);
    if (errors.length > 0) {
      throw new Error(`Invalid env var ${name}: ${errors.map((e) => e.message).join('; ')}`);
    }
  }

  const usersService = ctx.app.service('users') as unknown as {
    patch(
      id: UserID,
      data: {
        env_vars?: Record<string, string>;
        env_var_scopes?: Record<string, 'global' | 'session'>;
      },
      params?: { user: { user_id: UserID; role: string | undefined }; authenticated: true }
    ): Promise<unknown>;
  };

  const env_var_scopes: Record<string, 'global' | 'session'> = {};
  for (const name of Object.keys(submit.values)) {
    env_var_scopes[name] = submit.scope;
  }

  // Single patch: values are written first (encrypted in the service), then
  // scopes applied in the same transaction.
  //
  // Auth: the users.patch hook (`register-hooks.ts:1435-1487`) demands either
  // (a) caller is admin, or (b) caller patches their own profile. Without
  // params it sees `params.user = undefined` and throws 403. We pass the
  // SUBMITTER's identity through — covers the common cases:
  //   • submitter == session creator (default)  → self-patch path
  //   • submitter is admin (any role >= admin)  → admin bypass path
  // The cross-user collaborator case (non-admin submitter ≠ session creator)
  // is a known limitation; see design doc §5.2.
  await usersService.patch(
    ctx.sessionCreatorUserId,
    { env_vars: submit.values, env_var_scopes },
    {
      user: { user_id: ctx.submitterUserId, role: ctx.submitterRole },
      authenticated: true,
    }
  );
}

export const envVarsWidget: WidgetRegistryEntry<EnvVarsParams, EnvVarsSubmit, EnvVarsResultMeta> = {
  type: 'env_vars',
  schemaVersion: 1,
  paramsSchema: envVarsParamsSchema,
  submitSchema: envVarsSubmitSchema,
  buildResultMeta: (submit) => ({
    names_submitted: Object.keys(submit.values),
    scope: submit.scope,
  }),
  applySubmit: applyEnvVarsSubmit,
  buildAutoResumePrompt: (rm) =>
    `[Agor] User submitted ${rm.names_submitted.join(', ')} (scope: ${rm.scope}). ` +
    `You can now retry the operation that needed ` +
    `${rm.names_submitted.length === 1 ? 'it' : 'them'}.`,
  buildDismissedPrompt: (params) =>
    `[Agor] User dismissed the request for ${params.names.join(', ')}. ` +
    `Do not re-request immediately — ask whether to proceed without, or move on to other work.`,
};

/** Idempotent registration helper, safe to call at every daemon boot. */
export function registerEnvVarsWidget(): void {
  registerWidget(envVarsWidget);
}
