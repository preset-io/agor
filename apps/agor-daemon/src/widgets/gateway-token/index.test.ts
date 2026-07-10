/**
 * gateway_token widget — daemon-side tests.
 *
 * Mirrors `widgets/env-vars/index.test.ts`: pure-ish over a stubbed `app`
 * surface, no FeathersJS bootstrap. Exercises the registry contract and the
 * security-critical ordering in `applySubmit`:
 *   - admin guard fires FIRST (denies non-admin + undefined role)
 *   - channel-binding validation (wrong branch / wrong type / missing)
 *   - submitted token fields must be a subset of the requested fields
 *   - test-before-enable: enable only when the probe shows no hard failure
 *   - result_meta + prompts never carry a token value or prefix
 */

import type { SlackTestResult, UserID } from '@agor/core/types';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { _resetWidgetRegistryForTests, getWidget } from '../registry';
import {
  classifyGatewayTokenTest,
  gatewayTokenParamsSchema,
  gatewayTokenSubmitSchema,
  gatewayTokenWidget,
  registerGatewayTokenWidget,
} from './index';

const PASS_RESULT: SlackTestResult = { ok: true, failures: [], notVerifiable: [] };

const defaultParams = {
  gatewayChannelId: 'chan-1',
  channelType: 'slack' as const,
  channelName: 'Eng Slack',
  fields: ['bot_token', 'app_token'],
  reason: 'Finish connecting the Slack channel.',
};

const defaultSubmit = {
  tokens: { bot_token: 'xoxb-super-secret', app_token: 'xapp-super-secret' },
};

interface MakeCtxOpts {
  submitterRole?: string | undefined;
  channel?:
    | { id: string; name: string; channel_type: string; target_branch_id: string }
    | null
    | undefined;
  session?: { branch_id?: string };
  testResult?: SlackTestResult;
}

function makeCtx(opts: MakeCtxOpts = {}) {
  const channel =
    opts.channel === undefined
      ? { id: 'chan-1', name: 'Eng Slack', channel_type: 'slack', target_branch_id: 'wt-1' }
      : opts.channel;
  const session = opts.session ?? { branch_id: 'wt-1' };
  const patchSpy = vi.fn(async () => ({}));
  const testCreateSpy = vi.fn(async () => opts.testResult ?? PASS_RESULT);
  const app = {
    service(name: string) {
      if (name === 'gateway-channels') {
        return { get: vi.fn(async () => channel ?? undefined), patch: patchSpy };
      }
      if (name === 'gateway-channels/test') {
        return { create: testCreateSpy };
      }
      if (name === 'sessions') {
        return { get: vi.fn(async () => session) };
      }
      throw new Error(`Unexpected service call: ${name}`);
    },
  };
  return {
    ctx: {
      app: app as never,
      sessionId: 'sess-1' as never,
      submitterUserId: 'user-admin' as UserID,
      submitterRole: 'submitterRole' in opts ? opts.submitterRole : 'admin',
      sessionCreatorUserId: 'user-creator' as UserID,
    },
    patchSpy,
    testCreateSpy,
  };
}

describe('gateway_token widget — registry registration', () => {
  beforeEach(() => {
    _resetWidgetRegistryForTests();
  });

  it('registers under the gateway_token type', () => {
    registerGatewayTokenWidget();
    const entry = getWidget('gateway_token');
    expect(entry).toBeDefined();
    expect(entry?.type).toBe('gateway_token');
    expect(entry?.schemaVersion).toBe(1);
  });

  it('is idempotent — repeated calls do not throw', () => {
    registerGatewayTokenWidget();
    expect(() => registerGatewayTokenWidget()).not.toThrow();
  });
});

describe('gateway_token widget — paramsSchema', () => {
  it('accepts the non-secret params', () => {
    expect(gatewayTokenParamsSchema.safeParse(defaultParams).success).toBe(true);
  });

  it('rejects unknown properties (strict) — no smuggled token values', () => {
    expect(
      gatewayTokenParamsSchema.safeParse({ ...defaultParams, bot_token: 'xoxb-leak' }).success
    ).toBe(false);
  });

  it('rejects an empty fields array', () => {
    expect(gatewayTokenParamsSchema.safeParse({ ...defaultParams, fields: [] }).success).toBe(
      false
    );
  });

  it('rejects duplicate fields', () => {
    expect(
      gatewayTokenParamsSchema.safeParse({ ...defaultParams, fields: ['bot_token', 'bot_token'] })
        .success
    ).toBe(false);
  });

  it('rejects field names outside the sensitive set', () => {
    expect(
      gatewayTokenParamsSchema.safeParse({ ...defaultParams, fields: ['not_a_secret'] }).success
    ).toBe(false);
  });
});

describe('gateway_token widget — submitSchema', () => {
  it('accepts a tokens map keyed by sensitive field names', () => {
    expect(gatewayTokenSubmitSchema.safeParse(defaultSubmit).success).toBe(true);
  });

  it('rejects token keys outside the sensitive set', () => {
    expect(gatewayTokenSubmitSchema.safeParse({ tokens: { arbitrary: 'value' } }).success).toBe(
      false
    );
  });

  it('rejects extra top-level properties (strict)', () => {
    expect(gatewayTokenSubmitSchema.safeParse({ ...defaultSubmit, enabled: true }).success).toBe(
      false
    );
  });
});

describe('gateway_token widget — applySubmit admin guard', () => {
  it('denies a non-admin submitter and writes nothing', async () => {
    const { ctx, patchSpy, testCreateSpy } = makeCtx({ submitterRole: 'member' });
    await expect(gatewayTokenWidget.applySubmit(ctx, defaultSubmit, defaultParams)).rejects.toThrow(
      /admin/i
    );
    expect(patchSpy).not.toHaveBeenCalled();
    expect(testCreateSpy).not.toHaveBeenCalled();
  });

  it('denies an undefined role (fails closed) and writes nothing', async () => {
    const { ctx, patchSpy } = makeCtx({ submitterRole: undefined });
    await expect(gatewayTokenWidget.applySubmit(ctx, defaultSubmit, defaultParams)).rejects.toThrow(
      /admin/i
    );
    expect(patchSpy).not.toHaveBeenCalled();
  });

  it('allows an admin submitter', async () => {
    const { ctx, patchSpy } = makeCtx({ submitterRole: 'admin' });
    await gatewayTokenWidget.applySubmit(ctx, defaultSubmit, defaultParams);
    expect(patchSpy).toHaveBeenCalledTimes(1);
  });
});

describe('gateway_token widget — authorizeDismiss (admin-only dismissal)', () => {
  it('rejects a non-admin dismissal', () => {
    const { ctx } = makeCtx({ submitterRole: 'member' });
    expect(() => gatewayTokenWidget.authorizeDismiss?.(ctx, defaultParams)).toThrow(/admin/i);
  });

  it('rejects an undefined-role dismissal (fails closed)', () => {
    const { ctx } = makeCtx({ submitterRole: undefined });
    expect(() => gatewayTokenWidget.authorizeDismiss?.(ctx, defaultParams)).toThrow(/admin/i);
  });

  it('allows an admin dismissal', () => {
    const { ctx } = makeCtx({ submitterRole: 'admin' });
    expect(() => gatewayTokenWidget.authorizeDismiss?.(ctx, defaultParams)).not.toThrow();
  });
});

describe('gateway_token widget — channel-binding validation', () => {
  it('rejects when the channel does not exist', async () => {
    const { ctx, patchSpy } = makeCtx({ channel: null });
    await expect(gatewayTokenWidget.applySubmit(ctx, defaultSubmit, defaultParams)).rejects.toThrow(
      /not found/i
    );
    expect(patchSpy).not.toHaveBeenCalled();
  });

  it('rejects when the channel type does not match the request', async () => {
    const { ctx, patchSpy } = makeCtx({
      channel: { id: 'chan-1', name: 'Eng', channel_type: 'github', target_branch_id: 'wt-1' },
    });
    await expect(gatewayTokenWidget.applySubmit(ctx, defaultSubmit, defaultParams)).rejects.toThrow(
      /type/i
    );
    expect(patchSpy).not.toHaveBeenCalled();
  });

  it('rejects an unsupported channel type', async () => {
    const { ctx, patchSpy } = makeCtx({
      channel: { id: 'chan-1', name: 'Eng', channel_type: 'discord', target_branch_id: 'wt-1' },
    });
    await expect(
      gatewayTokenWidget.applySubmit(ctx, defaultSubmit, {
        ...defaultParams,
        channelType: 'discord' as never,
      })
    ).rejects.toThrow(/does not support/i);
    expect(patchSpy).not.toHaveBeenCalled();
  });

  it("rejects when the channel targets a different branch than the host session's", async () => {
    const { ctx, patchSpy } = makeCtx({ session: { branch_id: 'wt-OTHER' } });
    await expect(gatewayTokenWidget.applySubmit(ctx, defaultSubmit, defaultParams)).rejects.toThrow(
      /branch/i
    );
    expect(patchSpy).not.toHaveBeenCalled();
  });
});

describe('gateway_token widget — field-subset enforcement', () => {
  it('rejects a submitted field that was not requested', async () => {
    const { ctx, patchSpy } = makeCtx();
    await expect(
      gatewayTokenWidget.applySubmit(ctx, defaultSubmit, {
        ...defaultParams,
        fields: ['bot_token'],
      })
    ).rejects.toThrow(/not requested/i);
    expect(patchSpy).not.toHaveBeenCalled();
  });

  it('accepts a strict subset of the requested fields', async () => {
    const { ctx, patchSpy } = makeCtx();
    await gatewayTokenWidget.applySubmit(
      ctx,
      { tokens: { bot_token: 'xoxb-only' } },
      defaultParams
    );
    expect(patchSpy).toHaveBeenCalledTimes(1);
  });
});

describe('gateway_token widget — test-before-enable', () => {
  it('enables the channel when the probe passes', async () => {
    const { ctx, patchSpy } = makeCtx({ testResult: PASS_RESULT });
    await gatewayTokenWidget.applySubmit(ctx, defaultSubmit, defaultParams);
    const [id, data, params] = patchSpy.mock.calls[0] as [string, Record<string, unknown>, unknown];
    expect(id).toBe('chan-1');
    expect(data.config).toEqual(defaultSubmit.tokens);
    expect(data.enabled).toBe(true);
    expect(params).toEqual({ user: { user_id: 'user-admin', role: 'admin' } });
  });

  it('leaves the channel disabled on a hard credential failure', async () => {
    const { ctx, patchSpy } = makeCtx({
      testResult: {
        ok: false,
        failures: [
          {
            capability: 'bot_token',
            reason: 'The bot token is invalid.',
            slackError: 'invalid_auth',
          },
        ],
        notVerifiable: [],
      },
    });
    await gatewayTokenWidget.applySubmit(ctx, defaultSubmit, defaultParams);
    const [, data] = patchSpy.mock.calls[0] as [string, Record<string, unknown>];
    expect(data.enabled).toBe(false);
  });

  it('still enables on a non-hard failure (bot not yet in channel)', async () => {
    const { ctx, patchSpy } = makeCtx({
      testResult: {
        ok: false,
        failures: [
          {
            capability: 'channel_access',
            reason: 'The bot is not a member of this channel; invite it.',
            slackError: 'not_in_channel',
          },
        ],
        notVerifiable: [],
      },
    });
    await gatewayTokenWidget.applySubmit(ctx, defaultSubmit, defaultParams);
    const [, data] = patchSpy.mock.calls[0] as [string, Record<string, unknown>];
    expect(data.enabled).toBe(true);
  });

  it('leaves the channel disabled when the app_token probe fails (Socket Mode)', async () => {
    const { ctx, patchSpy } = makeCtx({
      testResult: {
        ok: false,
        appTokenValid: false,
        failures: [
          {
            capability: 'app_token',
            reason:
              'No app-level token is configured; Socket Mode cannot connect to receive messages.',
          },
        ],
        notVerifiable: [],
      },
    });
    await gatewayTokenWidget.applySubmit(ctx, defaultSubmit, defaultParams);
    const [, data] = patchSpy.mock.calls[0] as [string, Record<string, unknown>];
    expect(data.enabled).toBe(false);
  });

  it('enables an outbound-only channel (bot_token only) despite the probe app_token failure', async () => {
    const { ctx, patchSpy } = makeCtx({
      testResult: {
        ok: false,
        appTokenValid: false,
        failures: [
          {
            capability: 'app_token',
            reason:
              'No app-level token is configured; Socket Mode cannot connect to receive messages.',
          },
        ],
        notVerifiable: [],
      },
    });
    await gatewayTokenWidget.applySubmit(
      ctx,
      { tokens: { bot_token: 'xoxb-outbound-only' } },
      { ...defaultParams, fields: ['bot_token'] }
    );
    const [, data] = patchSpy.mock.calls[0] as [string, Record<string, unknown>];
    expect(data.enabled).toBe(true);
  });

  it('leaves the channel disabled when the connector cannot be built', async () => {
    const { ctx, patchSpy } = makeCtx({
      testResult: {
        ok: false,
        failures: [{ capability: 'config', reason: 'Missing required config.' }],
        notVerifiable: [],
      },
    });
    await gatewayTokenWidget.applySubmit(ctx, defaultSubmit, defaultParams);
    const [, data] = patchSpy.mock.calls[0] as [string, Record<string, unknown>];
    expect(data.enabled).toBe(false);
  });

  it('saves tokens but leaves an unprobable channel (github) disabled + flagged unverified', async () => {
    const { ctx, patchSpy } = makeCtx({
      channel: {
        id: 'chan-1',
        name: 'Eng GitHub',
        channel_type: 'github',
        target_branch_id: 'wt-1',
      },
      testResult: {
        ok: false,
        failures: [
          { capability: 'connector', reason: 'This channel type cannot be tested automatically.' },
        ],
        notVerifiable: [],
      },
    });
    const submit = { tokens: { private_key: 'gh-private-key-value' } };
    await gatewayTokenWidget.applySubmit(ctx, submit, {
      ...defaultParams,
      channelType: 'github',
      channelName: 'Eng GitHub',
      fields: ['private_key'],
    });
    const [, data] = patchSpy.mock.calls[0] as [string, Record<string, unknown>];
    // Tokens are still written, but the channel must NOT be enabled off an unrun probe.
    expect(data.config).toEqual({ private_key: 'gh-private-key-value' });
    expect(data.enabled).toBe(false);
    const rm = gatewayTokenWidget.buildResultMeta(submit);
    expect(rm.unverified).toBe(true);
    expect(rm.enabled).toBe(false);
    expect(JSON.stringify(rm)).not.toContain('gh-private-key-value');
  });
});

describe('classifyGatewayTokenTest', () => {
  it('enables on a clean pass', () => {
    expect(classifyGatewayTokenTest(PASS_RESULT, true)).toEqual({
      enable: true,
      status: 'verified',
      summary: 'passed',
    });
  });

  it('does not treat rate-limit as a hard failure', () => {
    const result = classifyGatewayTokenTest(
      {
        ok: false,
        failures: [{ capability: 'bot_token', reason: 'rate-limited', slackError: 'ratelimited' }],
        notVerifiable: [],
      },
      true
    );
    expect(result.enable).toBe(true);
  });

  it('treats token_revoked as a hard failure regardless of app_token expectation', () => {
    const result = classifyGatewayTokenTest(
      {
        ok: false,
        failures: [{ capability: 'bot_token', reason: 'revoked', slackError: 'token_revoked' }],
        notVerifiable: [],
      },
      false
    );
    expect(result.enable).toBe(false);
    expect(result.summary).toBe('revoked');
  });

  it('treats an app_token capability failure as a hard failure when app_token is expected (inbound)', () => {
    const result = classifyGatewayTokenTest(
      {
        ok: false,
        appTokenValid: false,
        failures: [
          {
            capability: 'app_token',
            reason:
              'No app-level token is configured; Socket Mode cannot connect to receive messages.',
          },
        ],
        notVerifiable: [],
      },
      true
    );
    expect(result.enable).toBe(false);
    expect(result.summary).toMatch(/Socket Mode/i);
  });

  it('treats appTokenValid:false as a hard failure when app_token is expected (inbound)', () => {
    const result = classifyGatewayTokenTest(
      { ok: false, appTokenValid: false, failures: [], notVerifiable: [] },
      true
    );
    expect(result.enable).toBe(false);
    expect(result.summary).toMatch(/app-level token/i);
  });

  it('does NOT hard-fail an app_token failure when app_token is not expected (outbound-only)', () => {
    // Outbound-only: the widget collected only bot_token, but the Slack probe
    // still emits an app_token failure / appTokenValid:false because no app
    // token exists. That must not block enabling.
    const result = classifyGatewayTokenTest(
      {
        ok: false,
        appTokenValid: false,
        failures: [
          {
            capability: 'app_token',
            reason:
              'No app-level token is configured; Socket Mode cannot connect to receive messages.',
          },
        ],
        notVerifiable: [],
      },
      false
    );
    expect(result.enable).toBe(true);
    // The irrelevant app_token failure is dropped from the follow-up summary.
    expect(result.summary).toBe('passed');
  });

  it('leaves an unprobable channel type (connector capability failure) unverified, never enabled', () => {
    // github/teams connectors have no testConnection, so the test service
    // returns a `connector`-capability failure. The credential was never
    // exercised, so tokens are saved but the channel must stay disabled.
    expect(
      classifyGatewayTokenTest(
        {
          ok: false,
          failures: [
            {
              capability: 'connector',
              reason: 'This channel type cannot be tested automatically.',
            },
          ],
          notVerifiable: [],
        },
        false
      )
    ).toEqual({
      enable: false,
      status: 'unverifiable',
      summary: 'credentials cannot be auto-verified for this channel type yet',
    });
  });

  it('treats a config-capability failure as a hard failure, not merely unverifiable', () => {
    const result = classifyGatewayTokenTest(
      {
        ok: false,
        failures: [{ capability: 'config', reason: 'Missing required config.' }],
        notVerifiable: [],
      },
      true
    );
    expect(result.enable).toBe(false);
    expect(result.status).toBe('failed');
  });
});

describe('gateway_token widget — buildResultMeta', () => {
  it('carries channel + enable outcome and NEVER a token value or prefix', async () => {
    const { ctx } = makeCtx();
    const submit = { tokens: { bot_token: 'xoxb-secret-abc', app_token: 'xapp-secret-xyz' } };
    await gatewayTokenWidget.applySubmit(ctx, submit, defaultParams);
    const rm = gatewayTokenWidget.buildResultMeta(submit);
    expect(rm.channelId).toBe('chan-1');
    expect(rm.channelName).toBe('Eng Slack');
    expect(rm.channelType).toBe('slack');
    expect(rm.fieldsSet).toEqual(['app_token', 'bot_token']);
    expect(rm.enabled).toBe(true);
    expect(rm.test.ok).toBe(true);
    const serialized = JSON.stringify(rm);
    expect(serialized).not.toContain('xoxb-');
    expect(serialized).not.toContain('xapp-');
    expect(serialized).not.toContain('secret-abc');
  });

  it('exposes only field NAMES even without an outcome', () => {
    const rm = gatewayTokenWidget.buildResultMeta({ tokens: { bot_token: 'xoxb-leak' } });
    expect(rm.fieldsSet).toEqual(['bot_token']);
    expect(JSON.stringify(rm)).not.toContain('xoxb-');
  });
});

describe('gateway_token widget — prompt builders', () => {
  const enabledMeta = {
    channelId: 'chan-1',
    channelName: 'Eng Slack',
    channelType: 'slack' as const,
    fieldsSet: ['app_token', 'bot_token'],
    enabled: true,
    unverified: false,
    test: { ok: true, summary: 'passed' },
  };

  it('buildAutoResumePrompt (enabled) names the channel + fields, no secrets', () => {
    const prompt = gatewayTokenWidget.buildAutoResumePrompt(enabledMeta, defaultParams);
    expect(prompt).toContain('Eng Slack');
    expect(prompt).toContain('bot_token');
    expect(prompt.toLowerCase()).toContain('enabled');
    expect(prompt).not.toContain('xoxb-');
    expect(prompt).not.toContain('xapp-');
  });

  it('buildAutoResumePrompt (disabled) reports the failure and asks to recheck', () => {
    const prompt = gatewayTokenWidget.buildAutoResumePrompt(
      { ...enabledMeta, enabled: false, test: { ok: false, summary: 'The bot token is invalid.' } },
      defaultParams
    );
    expect(prompt.toLowerCase()).toContain('disabled');
    expect(prompt).toContain('The bot token is invalid.');
    expect(prompt.toLowerCase()).toMatch(/double-check|check/);
  });

  it('buildAutoResumePrompt (unverified) reports tokens saved, left disabled, verify manually — no secrets', () => {
    const prompt = gatewayTokenWidget.buildAutoResumePrompt(
      {
        channelId: 'chan-1',
        channelName: 'Eng GitHub',
        channelType: 'github',
        fieldsSet: ['private_key'],
        enabled: false,
        unverified: true,
        test: { ok: false, summary: '' },
      },
      {
        ...defaultParams,
        channelType: 'github',
        channelName: 'Eng GitHub',
        fields: ['private_key'],
      }
    );
    expect(prompt).toContain('Eng GitHub');
    expect(prompt.toLowerCase()).toContain('disabled');
    expect(prompt.toLowerCase()).toContain('manually');
    expect(prompt).not.toContain('gh-');
  });

  it('buildDismissedPrompt names the channel and says not to re-ask', () => {
    const prompt = gatewayTokenWidget.buildDismissedPrompt(defaultParams);
    expect(prompt).toContain('Eng Slack');
    expect(prompt.toLowerCase()).toMatch(/don't immediately re-ask|do not.*re-ask/);
    expect(prompt).not.toContain('xoxb-');
  });
});
