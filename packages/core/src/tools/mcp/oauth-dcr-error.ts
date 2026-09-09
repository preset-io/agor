import { MCP_OAUTH_DCR_FAILURE_REASONS, type MCPOAuthDCRDiagnostic } from '../../types/mcp.js';

// Nominal, immutable snapshots: classification never reads exception getters,
// provider prose, or a diagnostic that a caller subsequently mutated.
const diagnostics = new WeakMap<object, Readonly<MCPOAuthDCRDiagnostic>>();

function own(value: unknown, key: string): unknown {
  try {
    if (!value || (typeof value !== 'object' && typeof value !== 'function')) return undefined;
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    return descriptor && 'value' in descriptor ? descriptor.value : undefined;
  } catch {
    return undefined;
  }
}

/** Safe, closed DCR evidence. This module has no transport dependencies. */
export class OAuthDCRFailure extends Error {
  readonly diagnostic: Readonly<MCPOAuthDCRDiagnostic>;

  constructor(message: string, diagnostic: MCPOAuthDCRDiagnostic) {
    super(message);
    this.name = 'OAuthDCRFailure';
    const status = own(diagnostic, 'http_status');
    const source = own(diagnostic, 'registration_endpoint_source');
    const reason = own(diagnostic, 'reason');
    this.diagnostic = Object.freeze({
      stage:
        own(diagnostic, 'stage') === 'dcr_endpoint_discovery'
          ? 'dcr_endpoint_discovery'
          : 'dcr_registration',
      ...(typeof status === 'number' && Number.isInteger(status) && status >= 200 && status <= 599
        ? { http_status: status }
        : {}),
      ...(source === 'metadata' || source === 'legacy_fallback'
        ? { registration_endpoint_source: source }
        : {}),
      ...(typeof reason === 'string' &&
      MCP_OAUTH_DCR_FAILURE_REASONS.includes(reason as NonNullable<MCPOAuthDCRDiagnostic['reason']>)
        ? { reason: reason as NonNullable<MCPOAuthDCRDiagnostic['reason']> }
        : {}),
    });
    diagnostics.set(this, this.diagnostic);
  }
}

export function getOAuthDCRDiagnostic(error: unknown): Readonly<MCPOAuthDCRDiagnostic> | undefined {
  return error !== null && (typeof error === 'object' || typeof error === 'function')
    ? diagnostics.get(error)
    : undefined;
}
