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

import {
  ENV_VAR_CONSTRAINTS,
  isEnvVarAllowed,
  type ValidationError,
  validateEnvVar,
} from '@agor/core/config';
import { type Database, SessionEnvSelectionRepository } from '@agor/core/db';
import { BadRequest } from '@agor/core/feathers';
import type { User, UserID } from '@agor/core/types';
import { z } from 'zod';
import { registerWidget, type WidgetRegistryEntry, type WidgetSubmitCtx } from '../registry.js';

/** Mirror of the regex used by the users service. */
const ENV_VAR_NAME_REGEX = ENV_VAR_CONSTRAINTS.NAME_PATTERN;

function orderedEnvVarNames(names: string[]): string[] {
  return [...names].sort();
}

const envVarFieldMetadataSchema = z
  .object({
    description: z.string().max(200).optional(),
    placeholder: z.string().max(120).optional(),
    format_hint: z.string().max(80).optional(),
    input_type: z.enum(['password', 'text', 'textarea']).default('password').optional(),
  })
  .strict();

export type EnvVarFieldMetadata = z.infer<typeof envVarFieldMetadataSchema>;

function orderedRecord<T>(record: Record<string, T> | undefined): Record<string, T> | undefined {
  if (!record) return undefined;
  const out: Record<string, T> = {};
  for (const key of orderedEnvVarNames(Object.keys(record))) {
    out[key] = record[key];
  }
  return out;
}

export function normalizeEnvVarsParams(params: EnvVarsParams): EnvVarsParams {
  return {
    ...params,
    names: orderedEnvVarNames(params.names),
    variable_metadata: orderedRecord(params.variable_metadata),
  };
}

/**
 * Agent-provided params (validated when the MCP tool fires).
 * Stored at `metadata.widget.params` on the widget message row.
 */
export const envVarsParamsSchema = z
  .object({
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
    variable_metadata: z
      .record(z.string().regex(ENV_VAR_NAME_REGEX), envVarFieldMetadataSchema)
      .optional()
      .describe(
        'Optional per-variable display metadata keyed by requested name. Allowed keys per variable: description, placeholder, format_hint, input_type (password|text|textarea). Do not include values, defaults, examples containing secrets, or anything secret-like.'
      ),
    auto_resume: z
      .boolean()
      .default(true)
      .describe(
        'When true (default), a system-authored prompt is auto-queued back into the agent on submit/dismiss.'
      ),
  })
  .superRefine((params, ctx) => {
    const requested = new Set(params.names);
    for (const key of Object.keys(params.variable_metadata ?? {})) {
      if (!requested.has(key)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['variable_metadata', key],
          message: `Metadata key ${key} must match a requested env var name`,
        });
      }
    }
  });

export type EnvVarsParams = z.infer<typeof envVarsParamsSchema>;

/**
 * Browser → daemon submit payload. Direct HTTP, never reaches the agent.
 */
export const envVarsSubmitSchema = z
  .object({
    values: z
      .record(
        z.string().regex(ENV_VAR_NAME_REGEX),
        z.string().min(1).max(ENV_VAR_CONSTRAINTS.MAX_VALUE_LENGTH)
      )
      .default({}),
    use_existing: z
      .array(z.string().regex(ENV_VAR_NAME_REGEX))
      .max(10)
      .default([])
      .describe('Requested names whose already-saved global values should be used.'),
    scope: z.enum(['global', 'session']),
  })
  .superRefine((submit, ctx) => {
    const valueNames = Object.keys(submit.values);
    const existingNames = submit.use_existing;
    const total = valueNames.length + existingNames.length;
    if (total < 1 || total > 10) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Must submit between 1 and 10 env vars',
      });
    }
    const duplicates = existingNames.filter((name) => valueNames.includes(name));
    for (const name of duplicates) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['use_existing'],
        message: `Cannot both submit and use existing value for ${name}`,
      });
    }
    if (new Set(existingNames).size !== existingNames.length) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['use_existing'],
        message: 'use_existing names must be unique',
      });
    }
  });

export type EnvVarsSubmit = z.infer<typeof envVarsSubmitSchema>;

/**
 * Result metadata: ONLY contains the names that were submitted + the scope.
 * NEVER includes values. This is the data that flows back into the agent
 * context via the auto-resume prompt.
 */
export interface EnvVarsResultMeta {
  names_submitted: string[];
  names_used_existing?: string[];
  scope: 'global' | 'session';
}

function fieldBadRequest(message: string, fieldErrors: Record<string, string>): BadRequest {
  return new BadRequest(message, { field_errors: orderedRecord(fieldErrors) });
}

function validationMessage(errors: ValidationError[]): string {
  return errors.map((e) => e.message).join('; ');
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
  const submittedNames = orderedEnvVarNames(Object.keys(submit.values));
  const useExistingNames = orderedEnvVarNames(submit.use_existing ?? []);
  const coveredNames = orderedEnvVarNames([...submittedNames, ...useExistingNames]);
  if (
    coveredNames.length !== params.names.length ||
    coveredNames.some((name) => !requestedNames.has(name))
  ) {
    const missing = params.names.filter((name) => !coveredNames.includes(name));
    const extra = coveredNames.filter((name) => !requestedNames.has(name));
    const fieldErrors: Record<string, string> = {};
    for (const name of missing)
      fieldErrors[name] = 'Required value or saved global value selection missing';
    for (const name of extra) fieldErrors[name] = 'This env var was not requested';
    throw fieldBadRequest(
      'Submitted env var names must exactly match the widget request: expected ' +
        params.names.join(', '),
      fieldErrors
    );
  }

  // Belt-and-braces: re-validate names against the same regex+blocklist
  // the users service uses, surfacing a single combined error if anything
  // fails. The users service would reject the same way, but doing it here
  // up-front gives us a clearer error per name without partial writes.
  for (const name of submittedNames) {
    if (!isEnvVarAllowed(name)) {
      throw fieldBadRequest(`Cannot set environment variable "${name}": blocked by allow-list`, {
        [name]: 'Blocked by allow-list',
      });
    }
    const errors = validateEnvVar(name, submit.values[name]);
    if (errors.length > 0) {
      const message = validationMessage(errors);
      throw fieldBadRequest(`Invalid env var ${name}: ${message}`, { [name]: message });
    }
  }

  const usersService = ctx.app.service('users') as unknown as {
    get(id: UserID, params?: unknown): Promise<User>;
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

  if (useExistingNames.length > 0) {
    const creator = await usersService.get(ctx.sessionCreatorUserId, {
      user: { user_id: ctx.submitterUserId, role: ctx.submitterRole },
      authenticated: true,
    });
    const fieldErrors: Record<string, string> = {};
    for (const name of useExistingNames) {
      const meta = creator.env_vars?.[name];
      if (!meta?.set) {
        fieldErrors[name] = 'No saved value is set for this env var';
      } else if (meta.scope !== 'global') {
        fieldErrors[name] = 'Only global saved values can be used from this widget';
      }
    }
    if (Object.keys(fieldErrors).length > 0) {
      throw fieldBadRequest('One or more saved values cannot be used', fieldErrors);
    }
  }

  const orderedValues: Record<string, string> = {};
  const env_var_scopes: Record<string, 'global' | 'session'> = {};
  for (const name of submittedNames) {
    orderedValues[name] = submit.values[name];
    env_var_scopes[name] = submit.scope;
  }

  // The widget submit endpoint already authorized the caller via
  // `canResolveWidget` (session-creator OR prompt-tier branch RBAC), so
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
  if (submittedNames.length > 0) {
    await usersService.patch(
      ctx.sessionCreatorUserId,
      { env_vars: orderedValues, env_var_scopes },
      {
        user: { user_id: ctx.submitterUserId, role: ctx.submitterRole },
        authenticated: true,
        trustedEnvVarWrite: true,
      }
    );
  }

  if (submit.scope === 'session' && submittedNames.length > 0) {
    const db = (ctx.app as unknown as { get?: (key: string) => unknown }).get?.('database') as
      | Database
      | undefined;
    if (db) {
      const repo = new SessionEnvSelectionRepository(db);
      const existing = await repo.asSet(ctx.sessionId);
      await repo.setAll(ctx.sessionId, orderedEnvVarNames([...existing, ...submittedNames]));
    }
  }
}

export const envVarsWidget: WidgetRegistryEntry<EnvVarsParams, EnvVarsSubmit, EnvVarsResultMeta> = {
  type: 'env_vars',
  schemaVersion: 1,
  paramsSchema: envVarsParamsSchema,
  submitSchema: envVarsSubmitSchema,
  buildResultMeta: (submit) => ({
    names_submitted: orderedEnvVarNames(Object.keys(submit.values)),
    ...(submit.use_existing.length > 0
      ? { names_used_existing: orderedEnvVarNames(submit.use_existing) }
      : {}),
    scope: submit.scope,
  }),
  applySubmit: applyEnvVarsSubmit,
  buildAutoResumePrompt: (rm) => {
    const existing = orderedEnvVarNames(rm.names_used_existing ?? []);
    const names = orderedEnvVarNames([...rm.names_submitted, ...existing]);
    const savedPart =
      rm.names_submitted.length > 0
        ? `saved ${orderedEnvVarNames(rm.names_submitted).join(', ')} (scope: ${rm.scope})`
        : '';
    const existingPart =
      existing.length > 0 ? `used existing ${existing.join(', ')} (scope: global)` : '';
    const action = [savedPart, existingPart].filter(Boolean).join(' and ');
    return (
      `[Agor] User ${action}. ` +
      `You can now retry the operation that needed ${names.length === 1 ? 'it' : 'them'}.`
    );
  },
  buildDismissedPrompt: (params) =>
    `[Agor] User dismissed the request for ${orderedEnvVarNames(params.names).join(', ')}. ` +
    `Do not re-request immediately — ask whether to proceed without, or move on to other work.`,
};

/** Idempotent registration helper, safe to call at every daemon boot. */
export function registerEnvVarsWidget(): void {
  registerWidget(envVarsWidget);
}
