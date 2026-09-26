import type { GatewayInboundEvent } from '@agor/core/types';

/**
 * Internal authority carried between the verified Teams HTTP queue and the
 * GatewayService. A symbol keeps this path out of JSON/Feathers transport
 * data, so an external caller can provide an event ID but cannot manufacture
 * the queue admission authority.
 */
const VERIFIED_HTTP_GATEWAY_AUTHORITY = Symbol('agor.gateway.verified_http');

export type VerifiedHttpGatewayCreate = {
  readonly [VERIFIED_HTTP_GATEWAY_AUTHORITY]: Pick<
    GatewayInboundEvent,
    | 'id'
    | 'gateway_channel_id'
    | 'processing_token'
    | 'provider_config_generation'
    | 'verified_app_id'
    | 'verified_tenant_id'
    | 'thread_id'
  >;
};

export function withVerifiedHttpGatewayAuthority<T extends object>(
  data: T,
  authority: VerifiedHttpGatewayCreate[typeof VERIFIED_HTTP_GATEWAY_AUTHORITY]
): T & VerifiedHttpGatewayCreate {
  const authorized = { ...data } as T & Partial<VerifiedHttpGatewayCreate>;
  Object.defineProperty(authorized, VERIFIED_HTTP_GATEWAY_AUTHORITY, {
    value: Object.freeze({
      id: authority.id,
      gateway_channel_id: authority.gateway_channel_id,
      processing_token: authority.processing_token,
      provider_config_generation: authority.provider_config_generation,
      verified_app_id: authority.verified_app_id,
      verified_tenant_id: authority.verified_tenant_id,
      thread_id: authority.thread_id,
    }),
    enumerable: false,
  });
  return authorized as T & VerifiedHttpGatewayCreate;
}

export function isVerifiedHttpGatewayCreate(value: unknown): value is VerifiedHttpGatewayCreate {
  return (
    !!value &&
    typeof value === 'object' &&
    !!(value as Partial<VerifiedHttpGatewayCreate>)[VERIFIED_HTTP_GATEWAY_AUTHORITY]
  );
}

export function verifiedHttpGatewayAuthority(value: unknown) {
  return isVerifiedHttpGatewayCreate(value) ? value[VERIFIED_HTTP_GATEWAY_AUTHORITY] : undefined;
}
