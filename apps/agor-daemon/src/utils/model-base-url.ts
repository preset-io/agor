/**
 * Shared policy for attacker-controllable model-provider base URLs
 * (`ANTHROPIC_BASE_URL` / `OPENAI_BASE_URL`).
 *
 * These are per-user and per-workspace settings that the daemon later fetches
 * from its own network position — auth checks (`check-auth.ts`) and model
 * discovery through a provider SDK (`claude-models.ts`). On an isolated,
 * multi-tenant, or HA deployment an attacker-set base URL is a blind SSRF /
 * port-scan oracle, so egress is locked to public, DNS-pinned destinations. A
 * trusted-local single-tenant install may still point at a local/self-hosted
 * endpoint. The deployment shape is read through the shared
 * {@link enforcesPublicHealthEgress} gate.
 */
import { type AgorConfig, enforcesPublicHealthEgress } from '@agor/core/config';
import { BadRequest } from '@agor/core/feathers';
import {
  assertSafeOutboundUrl,
  type OutboundDnsLookup,
  safeOutboundFetch,
} from '@agor/core/utils/safe-outbound-fetch';

const BASE_URL_VALIDATION_TIMEOUT_MS = 5_000;

/** Model-provider base-URL fields the daemon later fetches. */
export const MODEL_PROVIDER_BASE_URL_FIELDS = ['ANTHROPIC_BASE_URL', 'OPENAI_BASE_URL'] as const;

export interface BaseUrlPolicyOptions {
  /** Injectable DNS boundary for deterministic resolve-then-rebind tests. */
  resolveDns?: OutboundDnsLookup;
}

/**
 * Validate one model-provider base URL before it is persisted. On an enforced
 * deployment it must be public HTTPS that does not resolve to a
 * private/loopback/link-local/ULA/metadata address (the `safeOutboundFetch`
 * policy); on a trusted-local install only basic http(s) shape is required.
 */
export async function assertSafeModelBaseUrl(
  value: string,
  field: string,
  config: AgorConfig,
  options: BaseUrlPolicyOptions = {}
): Promise<void> {
  const trimmed = value.trim();
  if (trimmed.length === 0) return;
  const enforcePublic = enforcesPublicHealthEgress(config);
  try {
    if (enforcePublic) {
      await assertSafeOutboundUrl(trimmed, {
        timeoutMs: BASE_URL_VALIDATION_TIMEOUT_MS,
        resolveDns: options.resolveDns,
      });
    } else {
      const parsed = new URL(trimmed);
      if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
        throw new Error('unsupported protocol');
      }
    }
  } catch {
    throw new BadRequest(
      enforcePublic
        ? `${field} must be a public HTTPS URL that does not resolve to a private or reserved address`
        : `${field} must be a valid http(s) URL`
    );
  }
}

/** Validate every known base-URL field in a flat per-tool connection record. */
export async function assertSafeConnectionBaseUrls(
  connection: Record<string, string | null | undefined> | undefined,
  config: AgorConfig,
  options: BaseUrlPolicyOptions = {}
): Promise<void> {
  if (!connection) return;
  for (const field of MODEL_PROVIDER_BASE_URL_FIELDS) {
    const raw = connection[field];
    if (typeof raw === 'string') {
      await assertSafeModelBaseUrl(raw, field, config, options);
    }
  }
}

/**
 * An SDK-compatible `fetch` that confines a model-provider SDK (which otherwise
 * uses a redirect-following default fetch) to public, DNS-pinned egress with no
 * redirect following, so even a validated public base URL cannot `302` to an
 * internal target and a legacy row saved before validation is still refused.
 * Returns `undefined` on a trusted-local install so the SDK keeps its default
 * fetch and may reach a local/self-hosted endpoint.
 */
export function createPinnedModelFetch(
  config: AgorConfig,
  options: BaseUrlPolicyOptions = {}
): typeof fetch | undefined {
  if (!enforcesPublicHealthEgress(config)) return undefined;
  const pinned = async (
    input: Parameters<typeof fetch>[0],
    init?: Parameters<typeof fetch>[1]
  ): Promise<Response> => {
    const target =
      typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const body = init?.body;
    return safeOutboundFetch(target, {
      method: init?.method,
      headers: init?.headers ?? undefined,
      body: typeof body === 'string' ? body : undefined,
      signal: init?.signal ?? undefined,
      redirect: 'error',
      resolveDns: options.resolveDns,
    });
  };
  return pinned as typeof fetch;
}
