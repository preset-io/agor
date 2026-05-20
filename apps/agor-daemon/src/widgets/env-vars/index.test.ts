/**
 * env_vars widget — daemon-side tests.
 *
 * Mirrors `widgets/submissions.test.ts` patterns: pure-ish over a stubbed
 * `app` surface, no FeathersJS bootstrap. Exercises the registry contract
 * (paramsSchema / submitSchema / buildResultMeta / applySubmit /
 * buildAutoResumePrompt / buildDismissedPrompt) and asserts the security
 * invariant that submitted values never leak.
 *
 * Test surface aligned with §7 Part 2 + §8 R5 of the design doc:
 *   - registry boot side-effect (`registerEnvVarsWidget` populates `getWidget`)
 *   - `applySubmit` calls `users.patch` with the right shape
 *   - bad names propagate as errors
 *   - `buildResultMeta` returns ONLY `{ names_submitted, scope }`
 *   - no submitted value ever appears in any logged or persisted payload
 *   - prompt-builders shape
 */

import type { UserID } from '@agor/core/types';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { _resetWidgetRegistryForTests, getWidget } from '../registry';
import {
  envVarsParamsSchema,
  envVarsSubmitSchema,
  envVarsWidget,
  registerEnvVarsWidget,
} from './index';

function makeCtx(
  patch?: (id: string, data: unknown, params: unknown) => unknown | Promise<unknown>
) {
  const patchSpy = vi.fn(async (id: string, data: unknown, params: unknown) => {
    return patch ? patch(id, data, params) : { user_id: id };
  });
  const app = {
    service(name: string) {
      if (name !== 'users') throw new Error(`Unexpected service call: ${name}`);
      return { patch: patchSpy };
    },
  };
  return {
    ctx: {
      app: app as never,
      sessionId: 'sess-1' as never,
      submitterUserId: 'user-creator' as UserID,
      submitterRole: 'member' as string | undefined,
      sessionCreatorUserId: 'user-creator' as UserID,
    },
    patchSpy,
  };
}

describe('env_vars widget — registry registration', () => {
  beforeEach(() => {
    _resetWidgetRegistryForTests();
  });

  it('registers under the env_vars type', () => {
    registerEnvVarsWidget();
    const entry = getWidget('env_vars');
    expect(entry).toBeDefined();
    expect(entry?.type).toBe('env_vars');
    expect(entry?.schemaVersion).toBe(1);
  });

  it('is idempotent — repeated calls do not throw', () => {
    registerEnvVarsWidget();
    expect(() => registerEnvVarsWidget()).not.toThrow();
  });
});

describe('env_vars widget — paramsSchema', () => {
  it('accepts valid UPPER_SNAKE names + reason', () => {
    const result = envVarsParamsSchema.safeParse({
      names: ['HUBSPOT_API_KEY'],
      reason: 'call hubspot',
    });
    expect(result.success).toBe(true);
    if (result.success) {
      // auto_resume default applied (scope is a user-only UI choice)
      expect(result.data.auto_resume).toBe(true);
    }
  });

  it('rejects lower-case env var names', () => {
    expect(
      envVarsParamsSchema.safeParse({
        names: ['hubspot_api_key'],
        reason: 'call hubspot',
      }).success
    ).toBe(false);
  });

  it('rejects empty names array', () => {
    expect(envVarsParamsSchema.safeParse({ names: [], reason: 'why' }).success).toBe(false);
  });

  it('rejects more than 10 names', () => {
    const names = Array.from({ length: 11 }, (_, i) => `VAR_${i}`);
    expect(envVarsParamsSchema.safeParse({ names, reason: 'why' }).success).toBe(false);
  });

  it('rejects empty reason', () => {
    expect(envVarsParamsSchema.safeParse({ names: ['X'], reason: '' }).success).toBe(false);
  });

  it('rejects duplicate names', () => {
    expect(
      envVarsParamsSchema.safeParse({ names: ['A_KEY', 'A_KEY'], reason: 'why' }).success
    ).toBe(false);
  });
});

describe('env_vars widget — submitSchema', () => {
  it('accepts one value with global scope', () => {
    expect(
      envVarsSubmitSchema.safeParse({
        values: { HUBSPOT_API_KEY: 'secret' },
        scope: 'global',
      }).success
    ).toBe(true);
  });

  it('rejects empty values map', () => {
    expect(envVarsSubmitSchema.safeParse({ values: {}, scope: 'global' }).success).toBe(false);
  });

  it('rejects invalid scope', () => {
    expect(
      envVarsSubmitSchema.safeParse({
        values: { X: 'v' },
        scope: 'invalid' as unknown as 'global',
      }).success
    ).toBe(false);
  });

  it('rejects lowercase variable name in values', () => {
    expect(
      envVarsSubmitSchema.safeParse({
        values: { lowercase_name: 'v' },
        scope: 'global',
      }).success
    ).toBe(false);
  });
});

describe('env_vars widget — buildResultMeta', () => {
  it('returns ONLY { names_submitted, scope } — never values', () => {
    const submit = {
      values: { HUBSPOT_API_KEY: 'super-secret-value' },
      scope: 'global' as const,
    };
    const rm = envVarsWidget.buildResultMeta(submit);
    expect(Object.keys(rm).sort()).toEqual(['names_submitted', 'scope']);
    expect(rm.names_submitted).toEqual(['HUBSPOT_API_KEY']);
    expect(rm.scope).toBe('global');
    expect(JSON.stringify(rm)).not.toContain('super-secret-value');
  });

  it('preserves submission order across multiple names', () => {
    const submit = {
      values: { A_KEY: 'a', B_KEY: 'b', C_KEY: 'c' },
      scope: 'session' as const,
    };
    const rm = envVarsWidget.buildResultMeta(submit);
    expect(rm.names_submitted).toEqual(['A_KEY', 'B_KEY', 'C_KEY']);
    expect(rm.scope).toBe('session');
  });
});

describe('env_vars widget — applySubmit', () => {
  it('calls users.patch with { env_vars, env_var_scopes } for the session creator', async () => {
    const { ctx, patchSpy } = makeCtx();
    await envVarsWidget.applySubmit(
      ctx,
      { values: { HUBSPOT_API_KEY: 'shh' }, scope: 'global' },
      { names: ['HUBSPOT_API_KEY'], reason: 'call hubspot', auto_resume: true }
    );
    expect(patchSpy).toHaveBeenCalledTimes(1);
    const [id, data, params] = patchSpy.mock.calls[0];
    expect(id).toBe('user-creator');
    expect(data).toEqual({
      env_vars: { HUBSPOT_API_KEY: 'shh' },
      env_var_scopes: { HUBSPOT_API_KEY: 'global' },
    });
    // Regression: must pass auth params so the users.patch hook accepts a
    // write to a user other than the caller via the `trustedEnvVarWrite`
    // escape hatch (the widget endpoint already authorized via canResolveWidget).
    expect(params).toEqual({
      user: { user_id: 'user-creator', role: 'member' },
      authenticated: true,
      trustedEnvVarWrite: true,
    });
  });

  it('passes submitter identity through for audit when an admin submits', async () => {
    const { ctx: baseCtx, patchSpy } = makeCtx();
    const adminCtx = {
      ...baseCtx,
      submitterUserId: 'user-admin' as UserID,
      submitterRole: 'admin',
    };
    await envVarsWidget.applySubmit(
      adminCtx,
      { values: { HUBSPOT_API_KEY: 'shh' }, scope: 'global' },
      { names: ['HUBSPOT_API_KEY'], reason: 'call hubspot', auto_resume: true }
    );
    const [, , params] = patchSpy.mock.calls[0];
    // Auth params carry the SUBMITTER identity so the patch is attributable.
    expect(params).toEqual({
      user: { user_id: 'user-admin', role: 'admin' },
      authenticated: true,
      trustedEnvVarWrite: true,
    });
  });

  it('writes ALL submitted names in one patch call', async () => {
    const { ctx, patchSpy } = makeCtx();
    await envVarsWidget.applySubmit(
      ctx,
      { values: { A_KEY: 'a', B_KEY: 'b' }, scope: 'session' },
      { names: ['A_KEY', 'B_KEY'], reason: 'why', auto_resume: true }
    );
    expect(patchSpy).toHaveBeenCalledTimes(1);
    const [, data] = patchSpy.mock.calls[0] as [string, Record<string, unknown>];
    expect(data.env_vars).toEqual({ A_KEY: 'a', B_KEY: 'b' });
    expect(data.env_var_scopes).toEqual({ A_KEY: 'session', B_KEY: 'session' });
  });

  it('rejects submitted names that do not exactly match params.names', async () => {
    const { ctx, patchSpy } = makeCtx();
    // Tampered client tries to write EXTRA_VAR that wasn't in the widget request.
    await expect(
      envVarsWidget.applySubmit(
        ctx,
        { values: { HUBSPOT_API_KEY: 'v', EXTRA_VAR: 'evil' }, scope: 'global' },
        { names: ['HUBSPOT_API_KEY'], reason: 'why', auto_resume: true }
      )
    ).rejects.toThrow(/exactly match/i);
    expect(patchSpy).not.toHaveBeenCalled();
  });

  it('rejects submitted names that are a subset of params.names', async () => {
    const { ctx, patchSpy } = makeCtx();
    // Client only submits one of the two requested vars — not an exact match.
    await expect(
      envVarsWidget.applySubmit(
        ctx,
        { values: { A_KEY: 'v' }, scope: 'global' },
        { names: ['A_KEY', 'B_KEY'], reason: 'why', auto_resume: true }
      )
    ).rejects.toThrow(/exactly match/i);
    expect(patchSpy).not.toHaveBeenCalled();
  });

  it('rejects blocklisted names before patching', async () => {
    const { ctx, patchSpy } = makeCtx();
    // PATH is on the blocklist (system identity).
    await expect(
      envVarsWidget.applySubmit(
        ctx,
        { values: { PATH: '/tmp/evil' }, scope: 'global' },
        { names: ['PATH'], reason: 'why', auto_resume: true }
      )
    ).rejects.toThrow(/blocked|cannot be set/i);
    expect(patchSpy).not.toHaveBeenCalled();
  });

  it('surfaces validation errors from the users-service patch', async () => {
    const { ctx } = makeCtx(() => {
      throw new Error('Invalid environment variable: value too long');
    });
    await expect(
      envVarsWidget.applySubmit(
        ctx,
        { values: { HUBSPOT_API_KEY: 'v' }, scope: 'global' },
        { names: ['HUBSPOT_API_KEY'], reason: 'why', auto_resume: true }
      )
    ).rejects.toThrow(/value too long/i);
  });

  it('widget shim does not log the submitted value (R5 — daemon-widget surface only)', async () => {
    // R5 in the design doc: submit handler must not log values. NOTE: this
    // test covers ONLY the widget-side shim (env-vars/index.ts applySubmit
    // + buildResultMeta). It stubs users.patch, so the users service's own
    // log paths aren't exercised here — those are tested separately at the
    // users-service level (it already only logs names, not values).
    const secret = 'super-leaky-secret-value-XYZ';
    const calls: unknown[][] = [];
    const spies = [
      vi.spyOn(console, 'log').mockImplementation((...args) => {
        calls.push(args);
      }),
      vi.spyOn(console, 'info').mockImplementation((...args) => {
        calls.push(args);
      }),
      vi.spyOn(console, 'warn').mockImplementation((...args) => {
        calls.push(args);
      }),
      vi.spyOn(console, 'error').mockImplementation((...args) => {
        calls.push(args);
      }),
      vi.spyOn(console, 'debug').mockImplementation((...args) => {
        calls.push(args);
      }),
    ];
    try {
      const { ctx } = makeCtx();
      await envVarsWidget.applySubmit(
        ctx,
        { values: { HUBSPOT_API_KEY: secret }, scope: 'global' },
        { names: ['HUBSPOT_API_KEY'], reason: 'why', auto_resume: true }
      );
      // Flatten every logged arg into a string and assert the secret is
      // nowhere in it. Covers stringified objects, error wrappers, etc.
      const allText = calls
        .flat()
        .map((v) => (typeof v === 'string' ? v : JSON.stringify(v)))
        .join(' ');
      expect(allText).not.toContain(secret);
    } finally {
      for (const s of spies) s.mockRestore();
    }
  });
});

describe('env_vars widget — prompt builders', () => {
  it('buildAutoResumePrompt names variables + scope + a retry nudge (no values)', () => {
    const params = {
      names: ['HUBSPOT_API_KEY'],
      reason: 'why',
      auto_resume: true,
    };
    const rm = { names_submitted: ['HUBSPOT_API_KEY'], scope: 'global' as const };
    const prompt = envVarsWidget.buildAutoResumePrompt(rm, params);
    expect(prompt).toContain('HUBSPOT_API_KEY');
    expect(prompt).toContain('global');
    expect(prompt.toLowerCase()).toMatch(/retry|proceed/);
    // It MUST NOT contain any secret-looking value
    expect(prompt).not.toMatch(/secret|value/i);
  });

  it('buildAutoResumePrompt uses "them" for multiple names', () => {
    const rm = { names_submitted: ['A', 'B'], scope: 'session' as const };
    const params = {
      names: ['A', 'B'],
      reason: 'why',
      auto_resume: true,
    };
    const prompt = envVarsWidget.buildAutoResumePrompt(rm, params);
    expect(prompt).toContain('them');
  });

  it('buildDismissedPrompt says "do not re-request immediately"', () => {
    const params = {
      names: ['HUBSPOT_API_KEY'],
      reason: 'why',
      auto_resume: true,
    };
    const prompt = envVarsWidget.buildDismissedPrompt(params);
    expect(prompt).toContain('HUBSPOT_API_KEY');
    expect(prompt).toContain('dismissed');
    expect(prompt.toLowerCase()).toMatch(/do not re-request|don't re-request/);
  });
});
