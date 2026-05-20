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
import { BadRequest } from '@agor/core/feathers';
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
    .refine((names) => new Set(names).size === names.length, {
      message: 'Env var names must be unique',
    })
    .describe('UPPER_SNAKE env var names (same validation as User Settings).'),
  reason: z
    .string()
    .min(1)
    .max(200)
    .describe(
      'One sentence explaining why you need the value(s). Keep it tight — this renders in a small muted line under the input. NOT a place to restate what the widget does.'
    ),
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
async function applyEnvVarsSubmit(
  ctx: WidgetSubmitCtx,
  submit: EnvVarsSubmit,
  params: EnvVarsParams
): Promise<void> {
  // Enforce that the browser submitted exactly the names the agent requested
  // (no more, no fewer). Without this, a tampered client could use the
  // `trustedEnvVarWrite` escape hatch to write arbitrary env vars onto the
  // session creator's profile — widening the attack surface far beyond what
  // the agent (and the user reviewing the widget) intended.
  const requestedNames = new Set(params.names);
  const submittedNames = Object.keys(submit.values);
  if (
    submittedNames.length !== params.names.length ||
    submittedNames.some((name) => !requestedNames.has(name))
  ) {
    throw new BadRequest(
      'Submitted env var names must exactly match the widget request: expected ' +
        params.names.join(', ')
    );
  }

  // Belt-and-braces: re-validate names against the same regex+blocklist
  // the users service uses, surfacing a single combined error if anything
  // fails. The users service would reject the same way, but doing it here
  // up-front gives us a clearer error per name without partial writes.
  for (const name of submittedNames) {
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
      params?: {
        user: { user_id: UserID; role: string | undefined };
        authenticated: true;
        trustedEnvVarWrite?: boolean;
      }
    ): Promise<unknown>;
  };

  const env_var_scopes: Record<string, 'global' | 'session'> = {};
  for (const name of submittedNames) {
    env_var_scopes[name] = submit.scope;
  }

  // The widget submit endpoint already authorized the caller via
  // `canResolveWidget` (session-creator OR prompt-tier worktree RBAC), so
  // we set `trustedEnvVarWrite` on the users.patch hook to bypass its
  // self-only check (`register-hooks.ts`). Field-level admin gates for
  // unix_username/role/must_change_password run first and are NOT bypassed.
  // The hook also enforces that only env_vars/env_var_scopes fields are
  // written — this escape hatch cannot be used to patch other user fields.
  //
  // submitter identity is still threaded through for audit; the widget
  // submit handler records it separately as `metadata.widget.submitted_by`.
  //
  // Grep for: trustedEnvVarWrite — to audit every site that sets it.
  await usersService.patch(
    ctx.sessionCreatorUserId,
    { env_vars: submit.values, env_var_scopes },
    {
      user: { user_id: ctx.submitterUserId, role: ctx.submitterRole },
      authenticated: true,
      trustedEnvVarWrite: true,
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
