export type GatewayListenerFailureKind = 'permanent' | 'transient' | 'lifecycle';

/** Safe, provider-neutral startup failure consumed by the daemon listener supervisor. */
export class GatewayListenerError extends Error {
  constructor(
    readonly code: string,
    readonly kind: GatewayListenerFailureKind,
    readonly remediation: string
  ) {
    super(code);
    this.name = 'GatewayListenerError';
  }
}

export function gatewayListenerFailure(error: unknown): GatewayListenerError {
  if (error instanceof GatewayListenerError) return error;
  return new GatewayListenerError(
    'provider_unavailable',
    'transient',
    'The provider could not be reached; Agor will retry automatically.'
  );
}
