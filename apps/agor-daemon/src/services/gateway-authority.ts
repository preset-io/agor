/**
 * Internal authority carried between the verified Teams HTTP queue and the
 * GatewayService. A symbol keeps this path out of JSON/Feathers transport
 * data, so an external caller can provide an event ID but cannot manufacture
 * the queue admission authority.
 */
const VERIFIED_HTTP_GATEWAY_AUTHORITY = Symbol('agor.gateway.verified_http');

export type VerifiedHttpGatewayCreate = {
  readonly [VERIFIED_HTTP_GATEWAY_AUTHORITY]: true;
};

export function withVerifiedHttpGatewayAuthority<T extends object>(
  data: T
): T & VerifiedHttpGatewayCreate {
  const authorized = { ...data } as T & Partial<VerifiedHttpGatewayCreate>;
  Object.defineProperty(authorized, VERIFIED_HTTP_GATEWAY_AUTHORITY, {
    value: true,
    enumerable: false,
  });
  return authorized as T & VerifiedHttpGatewayCreate;
}

export function isVerifiedHttpGatewayCreate(value: unknown): value is VerifiedHttpGatewayCreate {
  return (
    !!value &&
    typeof value === 'object' &&
    (value as Partial<VerifiedHttpGatewayCreate>)[VERIFIED_HTTP_GATEWAY_AUTHORITY] === true
  );
}
