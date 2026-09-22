/**
 * The operation budget and phase boundaries for one MCP `oauth-start`.
 *
 * A module of its own rather than a block inside `register-services.ts`, for
 * one reason: the budget is a claim about behaviour under a provider that
 * does not answer, and a claim like that needs a test that can drive it
 * directly. Buried in a 6000-line service registration it could only ever
 * have been exercised through a live HTTP fixture, which is exactly the kind
 * of coverage that does not get written.
 *
 * See `docs/internal/slack-mcp-oauth-connect-2026-09-16.md` for the incident
 * this answers: a user waited seventy seconds on a blank popup, and neither
 * they nor the log could tell a slow start from a hung one.
 */

/**
 * How long one `oauth-start` may spend on provider work before giving up.
 *
 * Every individual outbound request in this flow is already bounded at 10-15s
 * (`oauth-mcp-transport.ts`, and the handshake probe's
 * `AbortSignal.timeout(15_000)`). What had no bound was the COMPOSITION, and
 * the composition is what a user experiences:
 *
 * - marketplace mode widens `fetchAuthorizationServerMetadata` to four
 *   candidate URLs, so discovery alone can legitimately spend ~60s before
 *   failing, on top of resource-metadata discovery above it;
 * - `MCPOAuthClientRegistrationAuthority.resolve` polls a fleet-wide DCR lease
 *   at 250ms for up to `REGISTRATION_WAIT_LIMIT_MS` (70s);
 * - the post-DCR database work is capped only by `statement_timeout`.
 *
 * Three minutes is deliberately generous against that sum rather than tuned
 * under it: the point is that the operation TERMINATES and says which phase
 * it was in, not that it terminates quickly. A user who waited 70 seconds on
 * a blank popup could not tell a slow start from a hung one, and neither
 * could the log.
 */
export const MCP_OAUTH_START_BUDGET_MS = 180_000;

/** The stages a slow `oauth-start` can be stuck in, named in the log. */
export type MCPOAuthStartPhase =
  | 'probe'
  | 'discovery'
  | 'registration'
  | 'lease_wait'
  | 'flow_create';

/**
 * Budget exhaustion, shaped so the existing classifier already knows it.
 *
 * `name = 'AbortError'` is an own data property, which is what
 * `isMCPAbortError` reads, so `classifyMCPAuthRecovery` resolves this to
 * `provider_unavailable` through the ordinary path rather than needing a
 * branch of its own. Carries no provider text.
 */
const mcpOAuthStartBudgetErrors = new WeakSet<object>();
function mcpOAuthStartBudgetExhausted(phase: MCPOAuthStartPhase): Error {
  const error = new Error(`MCP OAuth start exceeded its budget during ${phase}`);
  error.name = 'AbortError';
  mcpOAuthStartBudgetErrors.add(error);
  return error;
}

/**
 * Run one phase of `oauth-start` under the operation budget, and say so.
 *
 * Two jobs, and the logging one is the more valuable. A phase-boundary line
 * per stage is what makes a slow start distinguishable from a hung one FROM
 * OUTSIDE — without it the only evidence a 70-second wait left behind was the
 * user saying "it was stuck", and the DCR lease wait in particular polls for
 * over a minute without writing anything at all.
 *
 * The budget clamp is per-phase against what is LEFT, so the phases compose to
 * the operation bound rather than each getting a fresh one. `Promise.race`
 * cannot cancel the work underneath; each individual request has its own
 * `AbortSignal`, and this is what stops the caller waiting on their sum.
 */
export function mcpOAuthStartPhaseRunner(deadline: number) {
  return async function runStartPhase<T>(
    phase: MCPOAuthStartPhase,
    run: () => Promise<T>
  ): Promise<T> {
    const startedAt = Date.now();
    const remaining = deadline - startedAt;
    const report = (outcome: string) =>
      console.log(
        `[OAuth Start] event=phase phase=${phase} outcome=${outcome} ms=${Date.now() - startedAt}`
      );
    if (remaining <= 0) {
      report('budget_exhausted');
      throw mcpOAuthStartBudgetExhausted(phase);
    }
    let timer: NodeJS.Timeout | undefined;
    try {
      const result = await Promise.race([
        run(),
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(() => reject(mcpOAuthStartBudgetExhausted(phase)), remaining);
          timer.unref?.();
        }),
      ]);
      report('ok');
      return result;
    } catch (error) {
      report(
        typeof error === 'object' && error !== null && mcpOAuthStartBudgetErrors.has(error)
          ? 'budget_exhausted'
          : 'failed'
      );
      throw error;
    } finally {
      if (timer) clearTimeout(timer);
    }
  };
}
