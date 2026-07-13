/**
 * gateway_token widget — registry entry and registration.
 *
 * Concrete widget type: an admin supplies a gateway channel's platform
 * credentials (Slack bot/app tokens, GitHub private key, Teams app password)
 * through an inline form. The values flow browser → daemon via
 * `POST /widgets/:widget_id/submit` and land in the channel's encrypted
 * `config` through the gateway-channels service — never through the agent's
 * MCP context. Setting a channel's tokens is admin-only, so `applySubmit`
 * gates on `ROLES.ADMIN` before touching anything.
 *
 * See §4 + §7 of `docs/internal/in-conversation-widgets-design-2026-05-19.md`.
 */

import { Forbidden } from '@agor/core/feathers';
import {
  type ChannelType,
  GATEWAY_SENSITIVE_CONFIG_FIELDS,
  hasMinimumRole,
  ROLES,
  type SlackTestResult,
  type UserID,
} from '@agor/core/types';
import { z } from 'zod';
import { registerWidget, type WidgetRegistryEntry, type WidgetSubmitCtx } from '../registry.js';

/**
 * Channel types whose credentials can be captured through this widget. These
 * are exactly the types `getRequiredSecretFields` returns non-empty for; the
 * remaining `ChannelType` values carry no encrypted secret to collect.
 */
const SUPPORTED_CHANNEL_TYPES = [
  'slack',
  'github',
  'teams',
] as const satisfies readonly ChannelType[];

export function isSupportedGatewayTokenChannelType(channelType: string): boolean {
  return (SUPPORTED_CHANNEL_TYPES as readonly string[]).includes(channelType);
}

/** Upper bound on a single credential value; a PEM private key is the largest. */
const MAX_TOKEN_LENGTH = 8192;

function orderedFields(fields: string[]): string[] {
  return [...fields].sort();
}

/**
 * Agent-provided params (validated when the MCP tool fires). All non-secret:
 * the channel identity, its type/name, and the field NAMES to collect. Stored
 * at `metadata.widget.params` on the widget message row.
 */
export const gatewayTokenParamsSchema = z
  .object({
    gatewayChannelId: z
      .string()
      .min(1)
      .describe('Gateway channel whose credentials are being set.'),
    channelType: z
      .enum(['slack', 'discord', 'whatsapp', 'telegram', 'github', 'teams'] as [
        ChannelType,
        ...ChannelType[],
      ])
      .describe('Platform type of the channel; drives per-field placeholders.'),
    channelName: z
      .string()
      .min(1)
      .max(200)
      .describe('Human-readable channel name for the form heading and prompts.'),
    fields: z
      .array(z.enum(GATEWAY_SENSITIVE_CONFIG_FIELDS))
      .min(1)
      .max(GATEWAY_SENSITIVE_CONFIG_FIELDS.length)
      .refine((fields) => new Set(fields).size === fields.length, {
        message: 'Token field names must be unique',
      })
      .describe('Secret config field names to collect (subset of the sensitive fields).'),
    reason: z
      .string()
      .min(1)
      .max(200)
      .describe('One sentence explaining why the tokens are needed. Renders as a muted line.'),
  })
  .strict();

export type GatewayTokenParams = z.infer<typeof gatewayTokenParamsSchema>;

/**
 * Browser → daemon submit payload. Direct HTTP, never reaches the agent. The
 * keys are constrained to the sensitive field names; the values are the raw
 * credentials that get encrypted by the gateway-channels service.
 */
export const gatewayTokenSubmitSchema = z
  .object({
    tokens: z
      // partialRecord — a submit carries only the requested SUBSET of fields;
      // plain z.record over an enum key is exhaustive in Zod v4 and would
      // reject any partial map.
      .partialRecord(
        z.enum(GATEWAY_SENSITIVE_CONFIG_FIELDS),
        z.string().min(1).max(MAX_TOKEN_LENGTH)
      )
      .describe('Map of sensitive field name → credential value.'),
  })
  .strict();

export type GatewayTokenSubmit = z.infer<typeof gatewayTokenSubmitSchema>;

/**
 * Sanitized post-resolution data written to the message row and fed into the
 * auto-resume prompt. Carries the channel identity, which fields were set, and
 * the enable/test outcome — but NEVER a token value, prefix, length, or
 * last-four.
 */
export interface GatewayTokenResultMeta {
  channelId: string;
  channelName: string;
  channelType: ChannelType;
  fieldsSet: string[];
  enabled: boolean;
  /**
   * True when the tokens were saved but the channel type has no probe, so the
   * credentials could NOT be validated and the channel was left disabled
   * pending manual confirmation. Distinct from an enable-blocking hard failure.
   */
  unverified: boolean;
  test: { ok: boolean; summary: string };
}

/**
 * `buildResultMeta` receives only the submit body (registry contract), yet the
 * enable decision and channel identity are computed inside `applySubmit`. This
 * WeakMap carries that outcome across the two calls — keyed on the shared
 * submit object identity, which `resolveWidget` passes to both in sequence.
 * Nothing here is secret; the token values stay out of it entirely.
 */
interface GatewayTokenOutcome {
  channelId: string;
  channelName: string;
  channelType: ChannelType;
  enabled: boolean;
  unverified: boolean;
  test: { ok: boolean; summary: string };
}

const submitOutcomes = new WeakMap<GatewayTokenSubmit, GatewayTokenOutcome>();

/**
 * Slack error codes that mean the submitted credential itself is bad — the
 * token is missing, malformed, revoked, expired, or belongs to a dead account.
 * These block enabling. Everything else a probe can surface (missing OAuth
 * scope, rate-limit, bot-not-in-channel) is a setup follow-up, not a reason to
 * distrust the token, so the channel still enables.
 */
const HARD_CREDENTIAL_SLACK_ERRORS = new Set([
  'invalid_auth',
  'account_inactive',
  'token_revoked',
  'token_expired',
  'not_authed',
  'no_permission',
]);

/**
 * Decide whether the probe result permits enabling the channel, a `status`
 * discriminator, and a short human summary. Three outcomes:
 *   - `failed` (enable:false) — a hard credential failure (bad token) or an
 *     unbuildable connector (`config` capability — malformed config).
 *   - `unverifiable` (enable:false) — the channel type has no probe at all
 *     (`connector` capability); tokens are saved but the channel stays disabled
 *     until the credentials are confirmed manually, never enabled off an unrun
 *     probe.
 *   - `verified` (enable:true) — the probe ran and surfaced no hard failure;
 *     the credentials are usable even if more setup remains.
 *
 * `appTokenExpected` is Socket-Mode / inbound intent for THIS channel (the
 * widget collected an app_token, i.e. `getRequiredSecretFields` asked for it).
 * When true, a missing/failed app-level token is ALSO a hard blocker: the
 * listener requires it (`hasListeningConfig` in services/gateway.ts), so an
 * enabled inbound channel without a working app_token could never receive
 * messages. When false (outbound-only — send via bot_token, no listener), the
 * Slack probe still emits an `app_token` capability failure / `appTokenValid:
 * false` because no app token exists, but that must NOT block enabling — the
 * channel does not use Socket Mode.
 */
export function classifyGatewayTokenTest(
  result: SlackTestResult,
  appTokenExpected: boolean
): {
  enable: boolean;
  status: 'verified' | 'unverifiable' | 'failed';
  summary: string;
} {
  // A `connector`-capability failure is the test service's signal that the
  // channel type has no `testConnection` probe (github/teams — see
  // gateway-channels-test.ts). The credential was never exercised, so the
  // tokens are saved but the channel must stay disabled and be flagged for
  // manual verification — never silently enabled off an unrun probe. This is
  // distinct from a `config`-capability failure, which IS a real
  // malformed-config error and remains a hard failure below.
  const unprobable = result.failures.some((failure) => failure.capability === 'connector');
  if (unprobable) {
    return {
      enable: false,
      status: 'unverifiable',
      summary: 'credentials cannot be auto-verified for this channel type yet',
    };
  }

  const isAppTokenFailure = (failure: SlackTestResult['failures'][number]): boolean =>
    failure.capability === 'app_token';
  const hardFailure = result.failures.find(
    (failure) =>
      (failure.slackError && HARD_CREDENTIAL_SLACK_ERRORS.has(failure.slackError)) ||
      failure.capability === 'config' ||
      (appTokenExpected && isAppTokenFailure(failure))
  );
  if (hardFailure) {
    return { enable: false, status: 'failed', summary: hardFailure.reason };
  }
  if (appTokenExpected && result.appTokenValid === false) {
    return {
      enable: false,
      status: 'failed',
      summary: 'The app-level token is missing or invalid; Socket Mode cannot connect.',
    };
  }
  if (result.ok) {
    return { enable: true, status: 'verified', summary: 'passed' };
  }
  // Outbound-only: the app_token probe failure is expected and irrelevant, so
  // drop it from the follow-ups rather than reporting a token this channel
  // never needed.
  const followUps = result.failures
    .filter((failure) => appTokenExpected || !isAppTokenFailure(failure))
    .map((failure) => failure.reason)
    .filter(Boolean);
  return {
    enable: true,
    status: 'verified',
    summary: followUps.length > 0 ? `passed, with follow-ups: ${followUps.join('; ')}` : 'passed',
  };
}

interface GatewayChannelSurface {
  id: string;
  name: string;
  channel_type: ChannelType;
  target_branch_id: string;
}

/**
 * Minimal typed surfaces for the internal service calls. The concrete Feathers
 * service types don't model the `{ user }` audit param on `patch`, so we cast
 * to just the shapes this handler needs (mirrors the env_vars widget).
 */
interface GatewayChannelsService {
  get(id: string, params?: unknown): Promise<GatewayChannelSurface | undefined>;
  patch(
    id: string,
    data: { config: Record<string, string>; enabled: boolean },
    params: { user: { user_id: UserID; role: string | undefined } }
  ): Promise<unknown>;
}

interface GatewayChannelsTestService {
  create(data: {
    gatewayChannelId: string;
    config: Record<string, string>;
  }): Promise<SlackTestResult>;
}

interface SessionsGetService {
  get(id: string, params?: unknown): Promise<{ branch_id?: string }>;
}

/**
 * Side-effect: validate the request against the bound channel, probe the
 * credentials, then write them (enabled iff the probe found no hard failure)
 * through the gateway-channels service. Encryption, sentinel-preserve, and
 * `refreshGatewayChannelState` all live in that service — this handler does not
 * reimplement them.
 */
/**
 * Only admins may set OR decline gateway channel tokens. `submitterRole` may be
 * undefined → normalizes to member → fails closed. Shared by the submit and
 * dismiss paths so neither can drift from the other; authoritative gate (the
 * gateway-channels admin hook self-skips on the internal patch).
 */
function assertGatewayTokenAdmin(ctx: WidgetSubmitCtx): void {
  if (!hasMinimumRole(ctx.submitterRole, ROLES.ADMIN)) {
    throw new Forbidden('Only admins can set gateway channel tokens');
  }
}

async function applyGatewayTokenSubmit(
  ctx: WidgetSubmitCtx,
  submit: GatewayTokenSubmit,
  params: GatewayTokenParams
): Promise<void> {
  // a. Admin guard FIRST.
  assertGatewayTokenAdmin(ctx);

  // b. Channel-binding validation (anti confused-deputy). The channel must
  // exist, be a supported type matching the request, and target the SAME
  // branch as the host session — otherwise a widget minted against one channel
  // could be replayed to write another.
  const channelsService = ctx.app.service('gateway-channels') as unknown as GatewayChannelsService;
  const channel = await channelsService.get(params.gatewayChannelId);
  if (!channel) {
    throw new Forbidden(`Gateway channel ${params.gatewayChannelId} not found`);
  }
  if (!isSupportedGatewayTokenChannelType(channel.channel_type)) {
    throw new Forbidden(
      `Gateway channel type "${channel.channel_type}" does not support token entry`
    );
  }
  if (channel.channel_type !== params.channelType) {
    throw new Forbidden('Gateway channel type does not match the widget request');
  }
  const sessionsService = ctx.app.service('sessions') as unknown as SessionsGetService;
  const session = await sessionsService.get(ctx.sessionId);
  if (!session.branch_id || channel.target_branch_id !== session.branch_id) {
    throw new Forbidden("Gateway channel is not bound to this session's branch");
  }

  // c. The submitted field names must be a subset of what was requested — a
  // tampered client cannot smuggle an unrequested secret field into config.
  const requested = new Set<string>(params.fields);
  const extra = Object.keys(submit.tokens).filter((field) => !requested.has(field));
  if (extra.length > 0) {
    throw new Forbidden(
      `Submitted token fields were not requested: ${orderedFields(extra).join(', ')}`
    );
  }

  // d. Test-before-enable. The probe merges these tokens as overrides onto the
  // stored config; a hard credential failure keeps the channel disabled.
  const testService = ctx.app.service(
    'gateway-channels/test'
  ) as unknown as GatewayChannelsTestService;
  const testResult = await testService.create({
    gatewayChannelId: params.gatewayChannelId,
    config: submit.tokens,
  });
  // Socket-Mode / inbound intent for THIS channel: the widget collected an
  // app_token (getRequiredSecretFields asked for it). Outbound-only channels
  // omit it, so the probe's unavoidable app_token failure must not block enable.
  const appTokenExpected = params.fields.includes('app_token');
  const { enable, status, summary } = classifyGatewayTokenTest(testResult, appTokenExpected);

  // Single internal patch → encryption + sentinel-preserve +
  // refreshGatewayChannelState (starts the Socket-Mode listener when enabled).
  // Submitter identity is threaded for audit; no `provider` so the internal
  // path runs.
  await channelsService.patch(
    params.gatewayChannelId,
    { config: submit.tokens, enabled: enable },
    { user: { user_id: ctx.submitterUserId, role: ctx.submitterRole } }
  );

  submitOutcomes.set(submit, {
    channelId: channel.id,
    channelName: channel.name,
    channelType: channel.channel_type,
    enabled: enable,
    unverified: status === 'unverifiable',
    test: { ok: testResult.ok, summary },
  });
}

export const gatewayTokenWidget: WidgetRegistryEntry<
  GatewayTokenParams,
  GatewayTokenSubmit,
  GatewayTokenResultMeta
> = {
  type: 'gateway_token',
  schemaVersion: 1,
  paramsSchema: gatewayTokenParamsSchema,
  submitSchema: gatewayTokenSubmitSchema,
  buildResultMeta: (submit) => {
    const outcome = submitOutcomes.get(submit);
    return {
      channelId: outcome?.channelId ?? '',
      channelName: outcome?.channelName ?? '',
      channelType: outcome?.channelType ?? 'slack',
      fieldsSet: orderedFields(Object.keys(submit.tokens)),
      enabled: outcome?.enabled ?? false,
      unverified: outcome?.unverified ?? false,
      test: outcome?.test ?? { ok: false, summary: '' },
    };
  },
  applySubmit: applyGatewayTokenSubmit,
  buildAutoResumePrompt: (rm, params) => {
    const fields = orderedFields(rm.fieldsSet).join(', ');
    const name = rm.channelName || params.channelName;
    const channelType = rm.channelType || params.channelType;
    if (rm.enabled) {
      return (
        `[Agor] User set the ${channelType} tokens (${fields}) for channel "${name}". ` +
        `Channel enabled. Connection test: ${rm.test.summary || 'passed'}.`
      );
    }
    if (rm.unverified) {
      return (
        `[Agor] Tokens saved for "${name}" (${fields}); ${channelType} credentials can't be ` +
        `auto-verified yet, so the channel is left disabled — enable it manually once confirmed.`
      );
    }
    return (
      `[Agor] User set the ${channelType} tokens (${fields}) for channel "${name}", ` +
      `but it was left disabled; test failed: ${rm.test.summary || 'unknown error'}. ` +
      `Ask the user to double-check the tokens/scopes.`
    );
  },
  buildDismissedPrompt: (params) =>
    `[Agor] User declined to provide tokens for "${params.channelName}"; it stays disabled. ` +
    `Don't immediately re-ask.`,
  // Dismissal is admin-only too — otherwise a member could terminally decline
  // an admin-only credential flow via the generic dismiss endpoint.
  authorizeDismiss: (ctx) => assertGatewayTokenAdmin(ctx),
};

/** Idempotent registration helper, safe to call at every daemon boot. */
export function registerGatewayTokenWidget(): void {
  registerWidget(gatewayTokenWidget);
}
