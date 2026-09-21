/**
 * Why a gateway read failed, in Agor's own words.
 *
 * The same discipline `gatewayFailureCode` applies to a provider exception
 * (`packages/core/src/gateway/provider-error.ts`), applied to Agor's own: a
 * closed, Agor-owned code set derived from the error's SHAPE — its `name` and
 * its stable `code` — and never from its message, its stack, or anything a
 * provider said. `context/guidelines/logging.md` asks a failure line for a
 * stable category, the operation, the relevant UUIDs and the retryability;
 * this supplies the first of those, and the call sites supply the rest.
 *
 * Shape, not `instanceof`: `@agor/core` is built with `splitting: false`, so
 * each bundled entry inlines its own copy of a module and an error class
 * crossing entries fails `instanceof` against the copy a caller holds
 * (§9/F4). `name` and `code` are strings on the value, so they survive the
 * crossing — which is the same reason `packaged-tenant-scope-smoke.mjs`
 * matches errors by name.
 *
 * `missing_tenant_scope` is named on its own because it is the failure the
 * MCP Slack lanes have now shipped SEVEN times — a caller holding tenant
 * CONTEXT but no tenant database SCOPE — and because it is otherwise
 * invisible: it happens before any delivery is attempted, so the
 * `stranded=true` delivery accounting never sees it. It is also the one that
 * arrives WRAPPED as often as not, which is why the cause chain is walked.
 */

/** Agor-owned reason a gateway read failed. Never a provider's, never the exception. */
export type GatewayReadFailureCategory =
  /** A caller held tenant identity but no tenant database scope. */
  | 'missing_tenant_scope'
  /** No trusted tenant identity was in scope at all. */
  | 'missing_tenant_identity'
  /** The deployment has no public base URL to build a browser link from. */
  | 'no_public_base_url'
  /** The database answered with a failure of its own. */
  | 'repository_error'
  /** Nothing above matched. The only category that says "go read the code". */
  | 'unexpected';

/** Stable `code` values this classifier recognises, and what each means. */
const CODE_CATEGORIES: Record<string, GatewayReadFailureCategory> = {
  TENANT_PUBLIC_BASE_URL_DATABASE_REQUIRED: 'missing_tenant_scope',
  TENANT_PUBLIC_BASE_URL_IDENTITY_REQUIRED: 'missing_tenant_identity',
  PUBLIC_BASE_URL_NOT_CONFIGURED: 'no_public_base_url',
};

/** Error `name` values this classifier recognises. */
const NAME_CATEGORIES: Record<string, GatewayReadFailureCategory> = {
  MissingTenantDatabaseScopeError: 'missing_tenant_scope',
};

/** Reading a property off an arbitrary thrown value must not throw in turn. */
function ownString(value: unknown, field: string): string | undefined {
  if (!value || (typeof value !== 'object' && typeof value !== 'function')) return undefined;
  try {
    const read = (value as Record<string, unknown>)[field];
    return typeof read === 'string' ? read : undefined;
  } catch {
    return undefined;
  }
}

/** How far down a `cause` chain to look before giving up. */
const MAX_CAUSE_DEPTH = 5;

export function classifyGatewayReadFailure(error: unknown, depth = 0): GatewayReadFailureCategory {
  const code = ownString(error, 'code');
  if (code && CODE_CATEGORIES[code]) return CODE_CATEGORIES[code];
  const name = ownString(error, 'name');
  if (name && NAME_CATEGORIES[name]) return NAME_CATEGORIES[name];

  // A repository wraps whatever the database layer threw, and the wrapper is
  // the less useful of the two answers: "Failed to get OAuth token" over a
  // `MissingTenantDatabaseScopeError` is the exact shape §9/F4 was found in.
  // So the cause decides whenever it can, and `repository_error` is what is
  // left when it cannot.
  if (depth < MAX_CAUSE_DEPTH) {
    const cause = (() => {
      if (!error || (typeof error !== 'object' && typeof error !== 'function')) return undefined;
      try {
        return (error as { cause?: unknown }).cause;
      } catch {
        return undefined;
      }
    })();
    if (cause !== undefined && cause !== null) {
      const fromCause = classifyGatewayReadFailure(cause, depth + 1);
      if (fromCause !== 'unexpected') return fromCause;
    }
  }

  if (name === 'RepositoryError') return 'repository_error';
  return 'unexpected';
}
