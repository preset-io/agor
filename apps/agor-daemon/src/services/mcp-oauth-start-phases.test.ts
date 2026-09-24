/**
 * The budget and the boundaries, driven directly.
 *
 * Both halves matter, and the logging half is the one that was actually
 * missing. Every individual request in an `oauth-start` was already bounded
 * at 10-15s; what had no bound was their COMPOSITION, and what had no record
 * at all was which stage a slow start was in. A user waited seventy seconds
 * on a blank popup and neither they nor the log could say whether it was
 * working or hung — the DCR lease wait alone polls for over a minute without
 * writing anything.
 *
 * So the assertions are: a phase says what it did and how long it took, the
 * phases compose to ONE bound rather than each taking a fresh one, and a
 * phase that never answers ends the operation instead of holding it.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { MCP_OAUTH_START_BUDGET_MS, mcpOAuthStartPhaseRunner } from './mcp-oauth-start-phases.js';

describe('mcpOAuthStartPhaseRunner', () => {
  let logged: string[];

  beforeEach(() => {
    logged = [];
    vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
      logged.push(args.map(String).join(' '));
    });
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  const lines = (phase: string) => logged.filter((line) => line.includes(`phase=${phase}`));

  it('reports one boundary line per phase, with its outcome and duration', async () => {
    const run = mcpOAuthStartPhaseRunner(Date.now() + MCP_OAUTH_START_BUDGET_MS);

    await expect(run('discovery', async () => 'metadata')).resolves.toBe('metadata');

    expect(lines('discovery')).toHaveLength(1);
    expect(lines('discovery')[0]).toContain('event=phase');
    expect(lines('discovery')[0]).toContain('outcome=ok');
    // The duration is the point: "which stage, and for how long" is what
    // distinguishes a slow start from a hung one from outside.
    expect(lines('discovery')[0]).toMatch(/ms=\d+/);
  });

  it('separates a phase that failed from a phase that ran out of budget', async () => {
    const run = mcpOAuthStartPhaseRunner(Date.now() + MCP_OAUTH_START_BUDGET_MS);

    await expect(
      run('registration', async () => {
        throw new Error('the provider refused');
      })
    ).rejects.toThrow('the provider refused');

    expect(lines('registration')[0]).toContain('outcome=failed');
    // An ordinary failure is passed through untouched — the classifier
    // downstream is the thing that decides what it means.
    expect(lines('registration')[0]).not.toContain('budget_exhausted');
  });

  it('ends a phase that never answers, rather than waiting on it', async () => {
    vi.useFakeTimers();
    const run = mcpOAuthStartPhaseRunner(Date.now() + MCP_OAUTH_START_BUDGET_MS);

    // The case no live fixture can express: not a rejection, not a slow
    // answer — no answer.
    const settled = run('flow_create', () => new Promise<never>(() => {}));
    const assertion = expect(settled).rejects.toThrow(/budget/i);
    await vi.advanceTimersByTimeAsync(MCP_OAUTH_START_BUDGET_MS + 1_000);
    await assertion;

    expect(lines('flow_create')[0]).toContain('outcome=budget_exhausted');
  });

  it('classifies budget exhaustion as an abort, so the existing classifier knows it', async () => {
    vi.useFakeTimers();
    const run = mcpOAuthStartPhaseRunner(Date.now() + MCP_OAUTH_START_BUDGET_MS);

    const settled = run('probe', () => new Promise<never>(() => {})).catch(
      (error: unknown) => error
    );
    await vi.advanceTimersByTimeAsync(MCP_OAUTH_START_BUDGET_MS + 1_000);
    const error = await settled;

    // `name` as an own data property is what `isMCPAbortError` reads, which
    // is how `classifyMCPAuthRecovery` resolves this to `provider_unavailable`
    // without needing a branch of its own.
    expect((error as Error).name).toBe('AbortError');
    expect(Object.hasOwn(error as object, 'name')).toBe(true);
    // Carries the phase, and nothing a provider said.
    expect((error as Error).message).toContain('probe');
  });

  it('spends ONE budget across the phases, not one budget each', async () => {
    vi.useFakeTimers();
    const run = mcpOAuthStartPhaseRunner(Date.now() + MCP_OAUTH_START_BUDGET_MS);

    // A first phase that consumes most of the operation budget...
    const slow = run('discovery', () => new Promise<never>(() => {}));
    const slowAssertion = expect(slow).rejects.toThrow(/budget/i);
    await vi.advanceTimersByTimeAsync(MCP_OAUTH_START_BUDGET_MS + 1_000);
    await slowAssertion;

    // ...leaves the next one nothing. Without this the phases would compose
    // to N * budget, and the "operation-level budget" would be a per-phase
    // one wearing its name.
    let secondPhaseRan = false;
    await expect(
      run('flow_create', async () => {
        secondPhaseRan = true;
        return 'never';
      })
    ).rejects.toThrow(/budget/i);
    expect(secondPhaseRan).toBe(false);
    expect(lines('flow_create')[0]).toContain('outcome=budget_exhausted');
  });
});
