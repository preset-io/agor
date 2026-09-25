import { normalizeMCPClientHint } from '@agor/core/types';
import { requestMethod } from './request-method.js';
import type { McpTokenRejectionReason } from './tokens.js';

type RejectionReason = McpTokenRejectionReason | 'invalid_personal_key' | 'session_missing';
type CredentialSource = 'authorization' | 'api_key' | 'none';

/**
 * Process-local operational sampling, not an auth rate limiter. Unauthenticated
 * traffic has no trusted tenant: retain only a fixed set of reason/operation buckets,
 * never tokens, IPs, claimed tenants, or request identifiers. One category cannot
 * suppress another (in particular, malformed traffic cannot hide expiry/errors).
 * No timers: suppressed counts are reported on the next eligible rejection.
 */
export function createMcpAuthRejectionLogger(now = Date.now) {
  const buckets = new Map<string, { at: number; suppressed: number }>();
  return (
    reason: RejectionReason,
    method: string,
    source: CredentialSource,
    body?: unknown,
    clientHint?: unknown
  ): void => {
    const rpc = requestMethod(body);
    // Both components are bounded code-owned categories. Unknown method names
    // all share 'other'; probe noise cannot suppress tools/call diagnostics.
    const key = `${reason}:${rpc}`;
    const time = now();
    const previous = buckets.get(key);
    if (previous && time >= previous.at && time - previous.at < 60_000) {
      previous.suppressed = Math.min(Number.MAX_SAFE_INTEGER, previous.suppressed + 1);
      return;
    }
    const safeMethod = ['POST', 'GET', 'DELETE'].includes(method) ? method : 'other';
    const log =
      reason === 'secret_missing' || reason === 'verify_error' ? console.error : console.warn;
    log(
      `[mcp.auth] rejected reason=${reason} sample_method=${safeMethod} sample_source=${source} sample_rpc=${rpc} client_hint=${normalizeMCPClientHint(clientHint)} suppressed=${previous?.suppressed ?? 0}`
    );
    buckets.set(key, { at: time, suppressed: 0 });
  };
}
