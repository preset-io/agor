/**
 * Shared helpers for `agor tenant restriction apply|inspect`.
 *
 * These commands are the runtime side of a controller-owned restriction: an
 * external control plane runs them as a non-interactive in-Cell Job against the
 * runtime database. They record and read INTENT. Neither command authenticates
 * its caller, proves containment, drains connections, or settles running work.
 *
 * stdout is a single machine-readable JSON line; stderr carries one bounded
 * `{ "error": <code> }` line on failure plus human audit text.
 */

import {
  type TenantRestrictionCommand,
  TenantRestrictionCommandSchema,
  type TenantRestrictionConflictCode,
} from '@agor/core/types';

/** Applied, or already in the requested state (`changed` says which). */
export const EXIT_APPLIED = 0;
/** Any failure that is not a conflict or an unsupported runtime. */
export const EXIT_FAILURE = 1;
/** The command lost to the recorded state (stale/conflicting/unprepared). */
export const EXIT_CONFLICT = 2;
/** The runtime is not PostgreSQL, so it holds no tenant restriction state. */
export const EXIT_UNSUPPORTED = 3;

/** Machine-readable stderr codes that are not restriction conflict codes. */
export type TenantRestrictionCliErrorCode =
  | 'invalid_command'
  | 'unsupported_runtime'
  | 'invalid_restriction_state'
  | 'failed';

/** Everything the CLI may print as `{"error":<code>}`. */
export type TenantRestrictionStderrCode =
  | TenantRestrictionConflictCode
  | TenantRestrictionCliErrorCode;

/** Only a code the protocol defines may be reported as a conflict. */
const CONFLICT_CODES: readonly TenantRestrictionConflictCode[] = [
  'identity_mismatch',
  'stale_revision',
  'revision_conflict',
  'release_not_prepared',
];

/** The flag shape both commands parse before building a protocol command. */
export interface TenantRestrictionApplyFlags {
  'tenant-id': string;
  'controller-id': string;
  'placement-id': string;
  'operation-id': string;
  revision: number;
  action: string;
}

/**
 * Build the version-1 protocol command from parsed flags. Validation is the
 * schema's, not the flag parser's, so the CLI cannot accept an identity or
 * revision the writer would later reject.
 */
export function buildTenantRestrictionCommand(
  flags: TenantRestrictionApplyFlags
): TenantRestrictionCommand {
  return TenantRestrictionCommandSchema.parse({
    version: 1,
    controllerId: flags['controller-id'],
    placementId: flags['placement-id'],
    operationId: flags['operation-id'],
    revision: flags.revision,
    action: flags.action,
  });
}

/**
 * Map a failure to its exit code and bounded stderr code. Conflict codes come
 * from the protocol so an orchestrator can branch on them; every other failure
 * collapses to a category. Error messages never cross this boundary.
 */
export function tenantRestrictionFailure(error: unknown): {
  exitCode: number;
  code: TenantRestrictionStderrCode;
} {
  const name = errorName(error);
  if (name === 'TenantRestrictionConflictError') {
    const code = (error as { code?: unknown }).code;
    const known = CONFLICT_CODES.find((candidate) => candidate === code);
    return { exitCode: EXIT_CONFLICT, code: known ?? 'failed' };
  }
  if (name === 'TenantRestrictionUnsupportedError') {
    return { exitCode: EXIT_UNSUPPORTED, code: 'unsupported_runtime' };
  }
  // A corrupt or unsupported stored row is not "unrestricted"; it is a failure.
  if (name === 'TenantRestrictionDataError') {
    return { exitCode: EXIT_FAILURE, code: 'invalid_restriction_state' };
  }
  if (name === 'InvalidTenantIdError' || name === 'ZodError') {
    return { exitCode: EXIT_FAILURE, code: 'invalid_command' };
  }
  return { exitCode: EXIT_FAILURE, code: 'failed' };
}

function errorName(error: unknown): string | undefined {
  if (error === null || typeof error !== 'object') return undefined;
  try {
    const name = (error as { name?: unknown }).name;
    return typeof name === 'string' ? name : undefined;
  } catch {
    return undefined;
  }
}

/** The single bounded failure line written to stderr. */
export function tenantRestrictionErrorLine(code: TenantRestrictionStderrCode): string {
  return JSON.stringify({ error: code });
}
