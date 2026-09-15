import { McpOAuthOperationResponseSchema } from '@agor/core/types';

/** Closed UI/metric vocabulary; never forward an exception message, response, URL or owner. */
export function managedOAuthFailureCode(error: unknown): string {
  if (!(error instanceof Error)) return 'managed_authority_unavailable';
  if (error.name === 'InvalidGrantError') return 'needs_reauth';
  if (error.name === 'AmbiguousRefreshError') return 'provider_outcome_ambiguous';
  if (error.name === 'ManagedMCPOAuthOperationError' && 'outcome' in error) {
    const parsed = McpOAuthOperationResponseSchema.safeParse(error.outcome);
    if (parsed.success && parsed.data.status !== 'succeeded') return parsed.data.failure_code;
  }
  return 'managed_authority_unavailable';
}
