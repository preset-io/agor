import { GatewayInboundEventRepository, type TenantScopedDatabase } from '@agor/core/db';
import {
  type ChannelType,
  GATEWAY_ADMISSION_FENCED_CHANNEL_TYPES,
  type GatewayInboundEvent,
} from '@agor/core/types';

/**
 * Internal authority carried between the verified Teams HTTP queue and the
 * GatewayService. A symbol keeps this path out of JSON/Feathers transport
 * data, so an external caller can provide an event ID but cannot manufacture
 * the queue admission authority.
 */
const VERIFIED_HTTP_GATEWAY_AUTHORITY = Symbol('agor.gateway.verified_http');

export type VerifiedHttpGatewayAuthority = Pick<
  GatewayInboundEvent,
  | 'id'
  | 'gateway_channel_id'
  | 'processing_token'
  | 'provider_config_generation'
  | 'verified_app_id'
  | 'verified_tenant_id'
  | 'thread_id'
>;

export type VerifiedHttpGatewayCreate = {
  readonly [VERIFIED_HTTP_GATEWAY_AUTHORITY]: VerifiedHttpGatewayAuthority;
};

export function withVerifiedHttpGatewayAuthority<T extends object>(
  data: T,
  authority: VerifiedHttpGatewayAuthority
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

/**
 * Provider-neutral check run inside the prompt route's Task-insert
 * transaction. It throws to refuse admission; its locks hold through commit.
 * Lock order: session turn lock → gateway channel row → provider event row.
 */
export type GatewayAdmissionFence = (tx: TenantScopedDatabase) => Promise<void>;

/**
 * Feathers params carrying the fence. A function cannot cross a REST or
 * socket transport, so only an in-process daemon caller can supply one.
 */
export interface GatewayAdmissionFenceParams {
  gatewayAdmissionFence?: GatewayAdmissionFence;
}

export function gatewayAdmissionFenceFromParams(
  params: unknown
): GatewayAdmissionFence | undefined {
  const fence = (params as GatewayAdmissionFenceParams | undefined)?.gatewayAdmissionFence;
  return typeof fence === 'function' ? fence : undefined;
}

/** True when a gateway-sourced Task of this provider must not be admitted unfenced. */
export function requiresGatewayAdmissionFence(channelType: unknown): boolean {
  return (GATEWAY_ADMISSION_FENCED_CHANNEL_TYPES as readonly ChannelType[]).includes(
    channelType as ChannelType
  );
}

/** Re-check a claimed Teams inbound event's lease, generation and identity. */
export function teamsInboundAdmissionFence(
  authority: VerifiedHttpGatewayAuthority
): GatewayAdmissionFence {
  return (tx) => new GatewayInboundEventRepository(tx).assertTeamsTaskAdmission(authority);
}
