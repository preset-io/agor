/**
 * Teams outbound send path: prepare (host check, token, client) before any
 * durable effect marker, then one bounded POST per chunk, then classify the
 * outcome the way the Bot Connector documents it.
 */

import { Activity, type ConversationReference } from '@microsoft/agents-activity';
import { ConnectorClient } from '@microsoft/agents-hosting';
import type { TeamsAddressRevocationReason } from '../../types/gateway';
import { isTeamsTokenHost } from '../teams-service-url';

/** Text budget per Teams message in UTF-16 units; the hard activity limit is ~100 KB. */
export const TEAMS_MESSAGE_TEXT_BUDGET = 40_000;

export function botFrameworkScope(serviceUrl: string): string {
  return new URL(serviceUrl).hostname.endsWith('.us')
    ? 'https://api.botframework.us'
    : 'https://api.botframework.com';
}

export type TeamsSendFailurePhase = 'prepare' | 'send';

/** Sanitized Teams send failure; never carries tokens, text, or provider prose. */
export class TeamsSendError extends Error {
  readonly phase: TeamsSendFailurePhase;
  readonly status?: number;
  readonly providerCode?: string;
  readonly networkCode?: string;
  readonly retryAfterMs?: number;
  readonly reason?: string;

  constructor(input: {
    phase: TeamsSendFailurePhase;
    status?: number;
    providerCode?: string;
    networkCode?: string;
    retryAfterMs?: number;
    reason?: string;
  }) {
    super(
      `Teams ${input.phase} failed${input.status ? ` status=${input.status}` : ''}${
        input.reason ? ` reason=${input.reason}` : ''
      }`
    );
    this.name = 'TeamsSendError';
    this.phase = input.phase;
    this.status = input.status;
    this.providerCode = input.providerCode;
    this.networkCode = input.networkCode;
    this.retryAfterMs = input.retryAfterMs;
    this.reason = input.reason;
  }
}

export type TeamsSendOutcome =
  /** The provider proved it did not accept the chunk; clear the marker and retry. */
  | { kind: 'retry'; code: string; retryAfterMs?: number; refreshToken?: boolean }
  /** 413: re-plan smaller chunks if nothing was sent yet. */
  | { kind: 'too_large'; code: 'provider_http_413' }
  /** The address can no longer be used (until a new verified activity re-arms it). */
  | { kind: 'revoked'; code: string; reason: TeamsAddressRevocationReason }
  /** The chunk may have been posted; never resend it. */
  | { kind: 'ambiguous'; code: string }
  /** The provider definitively rejected the chunk. */
  | { kind: 'terminal'; code: string };

const REVOKING_PROVIDER_CODES: Record<string, TeamsAddressRevocationReason> = {
  BotNotInConversationRoster: 'bot_removed',
  ConversationBlockedByUser: 'conversation_blocked',
  MessageWritesBlocked: 'writes_blocked',
  ConversationNotFound: 'conversation_not_found',
  BotDisabledByAdmin: 'bot_disabled',
};

const NON_ACCEPTANCE_NETWORK_CODES = new Set([
  'ECONNREFUSED',
  'ENOTFOUND',
  'EAI_AGAIN',
  'EHOSTUNREACH',
  'ENETUNREACH',
  'UND_ERR_CONNECT_TIMEOUT',
  'CERT_HAS_EXPIRED',
  'DEPTH_ZERO_SELF_SIGNED_CERT',
  'ERR_TLS_CERT_ALTNAME_INVALID',
  'SELF_SIGNED_CERT_IN_CHAIN',
  'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
]);

/** Map a Teams send failure to the delivery state machine (Bot Connector status table). */
export function classifyTeamsSendFailure(error: unknown): TeamsSendOutcome {
  if (!(error instanceof TeamsSendError))
    return { kind: 'ambiguous', code: 'provider_effect_unknown' };
  if (error.phase === 'prepare') {
    return error.reason === 'service_url_not_allowed' || error.reason === 'address_invalid'
      ? { kind: 'terminal', code: `conversation_${error.reason}` }
      : { kind: 'retry', code: error.reason ?? 'send_prepare_failed' };
  }
  const status = error.status;
  if (status === undefined) {
    return error.networkCode && NON_ACCEPTANCE_NETWORK_CODES.has(error.networkCode)
      ? { kind: 'retry', code: 'provider_unreachable' }
      : { kind: 'ambiguous', code: 'provider_effect_unknown' };
  }
  if (status === 429) {
    return { kind: 'retry', code: 'provider_rate_limited', retryAfterMs: error.retryAfterMs };
  }
  if (status === 412) return { kind: 'retry', code: 'provider_http_412' };
  if (status === 401) return { kind: 'retry', code: 'provider_http_401', refreshToken: true };
  if (status === 413) return { kind: 'too_large', code: 'provider_http_413' };
  const reason = error.providerCode ? REVOKING_PROVIDER_CODES[error.providerCode] : undefined;
  if (reason && (status === 403 || status === 404)) {
    return { kind: 'revoked', code: `provider_${error.providerCode}`, reason };
  }
  if (status > 500 && status < 600) {
    return { kind: 'ambiguous', code: `provider_http_${status}` };
  }
  return { kind: 'terminal', code: `provider_http_${status}` };
}

/** A Retry-After value (delay-seconds or HTTP date) in milliseconds. */
export function parseRetryAfterMs(value: string | null | undefined): number | undefined {
  if (!value) return undefined;
  const seconds = Number(value);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1_000);
  const at = Date.parse(value);
  return Number.isFinite(at) ? Math.max(0, at - Date.now()) : undefined;
}

function networkCode(error: unknown): string | undefined {
  let current: unknown = error;
  for (let depth = 0; depth < 4 && current && typeof current === 'object'; depth += 1) {
    const code = (current as { code?: unknown }).code;
    if (typeof code === 'string') return code;
    current = (current as { cause?: unknown }).cause;
  }
  return undefined;
}

function sendFailure(error: unknown): TeamsSendError {
  if (error instanceof TeamsSendError) return error;
  const record = error as {
    name?: unknown;
    status?: unknown;
    response?: { data?: unknown; headers?: unknown };
  };
  if (record?.name === 'HttpError' && typeof record.status === 'number') {
    const body = record.response?.data as { error?: { code?: unknown } } | undefined;
    const code = body?.error?.code;
    const headers = record.response?.headers as Headers | undefined;
    return new TeamsSendError({
      phase: 'send',
      status: record.status,
      providerCode: typeof code === 'string' ? code.slice(0, 64) : undefined,
      retryAfterMs: parseRetryAfterMs(
        typeof headers?.get === 'function' ? headers.get('retry-after') : null
      ),
    });
  }
  return new TeamsSendError({ phase: 'send', networkCode: networkCode(error) });
}

export interface TeamsAccessTokenProvider {
  getAccessToken(scope: string): Promise<string>;
}

/** A send target whose token and host were verified before any effect marker. */
export interface PreparedTeamsSend {
  send(text: string, signal?: AbortSignal): Promise<string>;
  /** Post a Bot Framework `typing` activity to the same conversation. */
  sendTyping(signal?: AbortSignal): Promise<void>;
}

/** Validate the address and fetch a token; every failure here is pre-effect. */
export async function prepareTeamsSend(
  address: Record<string, unknown>,
  tokens: TeamsAccessTokenProvider,
  options: { textBudget?: number } = {}
): Promise<PreparedTeamsSend> {
  const reference = address as unknown as ConversationReference;
  const conversationId = reference.conversation?.id;
  if (typeof conversationId !== 'string' || !conversationId) {
    throw new TeamsSendError({ phase: 'prepare', reason: 'address_invalid' });
  }
  if (!isTeamsTokenHost(reference.serviceUrl)) {
    throw new TeamsSendError({ phase: 'prepare', reason: 'service_url_not_allowed' });
  }
  const serviceUrl = reference.serviceUrl;
  let token: string;
  try {
    token = await tokens.getAccessToken(botFrameworkScope(serviceUrl));
  } catch {
    throw new TeamsSendError({ phase: 'prepare', reason: 'token_unavailable' });
  }
  if (!token) throw new TeamsSendError({ phase: 'prepare', reason: 'token_unavailable' });
  const client = ConnectorClient.createClientWithToken(serviceUrl, token);
  const budget = options.textBudget ?? TEAMS_MESSAGE_TEXT_BUDGET;
  const post = async (fields: Record<string, unknown>, signal?: AbortSignal) => {
    const activity = Activity.fromObject(fields);
    activity.applyConversationReference(reference);
    const body = JSON.parse(activity.toJsonString()) as Record<string, unknown>;
    const replyToId = activity.replyToId;
    const url = replyToId
      ? `v3/conversations/${conversationId}/activities/${encodeURIComponent(replyToId)}`
      : `v3/conversations/${conversationId}/activities`;
    try {
      const response = await client.httpClient.request<{ id?: unknown }>({
        method: 'post',
        url,
        data: body,
        signal,
      });
      return typeof response.data?.id === 'string' ? response.data.id : '';
    } catch (error) {
      throw sendFailure(error);
    }
  };
  return {
    async send(text, signal) {
      if (text.length > budget) {
        throw new TeamsSendError({ phase: 'send', status: 413, reason: 'chunk_over_budget' });
      }
      return post({ type: 'message', text, textFormat: 'markdown' }, signal);
    },
    async sendTyping(signal) {
      // Same shape the Agents SDK typing timer sends: a bare `typing` activity on the reference.
      await post({ type: 'typing' }, signal);
    },
  };
}
