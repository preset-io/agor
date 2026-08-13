/**
 * Claude Subscription OAuth Sign-In Service (SPIKE — see draft PR)
 *
 * Drives Anthropic's Claude Code OAuth authorization natively from the daemon so
 * the onboarding wizard can sign a user into their Claude subscription without a
 * terminal or `claude setup-token` paste.
 *
 * Unlike Codex, Anthropic exposes NO device-authorization endpoint, so the
 * daemon cannot poll for approval. The flow is authorization-code + PKCE with a
 * paste-back code (the reverse of the Codex device flow):
 *
 *   1. `create({})` → the daemon generates a PKCE verifier/challenge and a state,
 *      builds the claude.ai/oauth/authorize URL, and returns it. The UI shows
 *      the link; phase is `awaiting_code`.
 *   2. The user approves in the browser and copies the `CODE#STATE` string the
 *      Anthropic callback page displays.
 *   3. `create({ code })` → the daemon splits `CODE#STATE`, checks `state`,
 *      exchanges `code` + verifier at the token endpoint for access/refresh
 *      tokens, writes `~/.claude/.credentials.json` (0600, as the Unix identity
 *      that runs Claude for this user), and flips the user's Claude auth method
 *      to `subscription`.
 *
 * One in-flight attempt per user: starting a new attempt replaces the previous.
 * Attempts live in daemon memory only — a restart discards them and the user
 * requests a fresh URL.
 *
 * SECURITY CONTRACT: tokens transit UI ↔ daemon ↔ Anthropic and the target
 * user's filesystem only. Status responses carry the authorize URL and
 * non-secret metadata; token material and the PKCE verifier are never returned,
 * logged, or exposed to any agent/LLM context. `state` is verified before
 * exchange. Callers act only on their own credentials.
 *
 * Design + verified-vs-assumed constants: context/explorations/claude-code-oauth-signin.md
 */

import { createHash, randomBytes } from 'node:crypto';
import { isTenantAgenticToolEnabled } from '@agor/core/config';
import {
  getCurrentTenantId,
  runWithTenantDatabaseScope,
  type TenantScopeAwareDatabase,
  type TenantScopedDatabase,
} from '@agor/core/db';
import { BadRequest, NotAuthenticated } from '@agor/core/feathers';
import type {
  AgenticAuthMethods,
  AuthenticatedParams,
  ClaudeOAuthStatus,
  TenantID,
  User,
  UserID,
} from '@agor/core/types';
import { writeClaudeAuthViaExecutor } from '../utils/executor-claude-auth.js';
import { type AppLike, resolveCodexUnixIdentity } from './codex-auth-shared.js';

// VERIFIED against @anthropic-ai/claude-agent-sdk@0.1.55's bundled cli.js (the
// build Agor loads) and cross-checked with the installed claude CLI v2.1.211.
/** Single fixed public OAuth client id shared by every Claude Code install. */
const CLAUDE_CLIENT_ID = '9d1c250a-e61b-44d9-88ed-5944d1962f5e';
const CLAUDE_AUTHORIZE_URL = 'https://claude.ai/oauth/authorize';
// TODO(verify): SDK 0.1.55 uses console.anthropic.com; CLI v2.1.211 uses
// platform.claude.com (console→platform rename in flight). Confirm which host
// the client id's redirect_uri is currently registered against — a mismatch is
// the most likely first failure. Both must agree with CLAUDE_REDIRECT_URI.
const CLAUDE_TOKEN_URL = 'https://console.anthropic.com/v1/oauth/token';
const CLAUDE_REDIRECT_URI = 'https://console.anthropic.com/oauth/code/callback';
// TODO(verify): extract the exact scope set for the pinned SDK rather than
// hardcoding. Too narrow silently disables features; too broad may be rejected.
const CLAUDE_SCOPES = ['user:inference', 'user:profile', 'user:sessions:claude_code'];

const FETCH_TIMEOUT_MS = 15_000;
/** How long a daemon-side attempt keeps its verifier/state before it must restart. */
const ATTEMPT_LIFETIME_MS = 10 * 60 * 1000;
/** How long a finished attempt stays queryable before eviction. */
const TERMINAL_ATTEMPT_TTL_MS = 60 * 60 * 1000;

async function fetchWithTimeout(url: string, init: RequestInit): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

function base64url(buffer: Buffer): string {
  return buffer.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

interface PkcePair {
  verifier: string;
  challenge: string;
}

/** RFC 7636 S256: challenge = base64url(sha256(verifier)). */
function generatePkce(): PkcePair {
  const verifier = base64url(randomBytes(32));
  const challenge = base64url(createHash('sha256').update(verifier).digest());
  return { verifier, challenge };
}

function buildAuthorizeUrl(challenge: string, state: string): string {
  const url = new URL(CLAUDE_AUTHORIZE_URL);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('client_id', CLAUDE_CLIENT_ID);
  url.searchParams.set('redirect_uri', CLAUDE_REDIRECT_URI);
  url.searchParams.set('scope', CLAUDE_SCOPES.join(' '));
  url.searchParams.set('code_challenge', challenge);
  url.searchParams.set('code_challenge_method', 'S256');
  url.searchParams.set('state', state);
  // TODO(verify): community reimplementations append `code=true` to force the
  // code-display page instead of a silent localhost redirect. Confirm whether
  // the pinned SDK requires it.
  url.searchParams.set('code', 'true');
  return url.toString();
}

interface ExchangedTokens {
  accessToken: string;
  refreshToken: string;
  expiresInSec: number;
  scopes: string[];
  subscriptionType?: string;
}

/** Split the pasted `CODE#STATE`; the state half is optional on some pages. */
function splitPastedCode(pasted: string): { code: string; state?: string } {
  const [code, state] = pasted.trim().split('#', 2);
  return { code, state: state || undefined };
}

async function exchangeCodeForTokens(
  code: string,
  verifier: string,
  state: string
): Promise<ExchangedTokens> {
  // TODO(verify): confirm content-type (application/json vs form-encoded) and
  // exact field names against the pinned SDK. JSON body is the community form.
  const res = await fetchWithTimeout(CLAUDE_TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      grant_type: 'authorization_code',
      code,
      state,
      client_id: CLAUDE_CLIENT_ID,
      redirect_uri: CLAUDE_REDIRECT_URI,
      code_verifier: verifier,
    }),
  });
  if (!res.ok) {
    // 4xx here is a rejected/expired code; nothing to retry.
    throw new BadRequest('Claude rejected the sign-in code — start over and paste a fresh code.');
  }

  const body = (await res.json()) as Record<string, unknown>;
  const { access_token, refresh_token, expires_in, scope } = body;
  if (typeof access_token !== 'string' || typeof refresh_token !== 'string') {
    throw new BadRequest('Claude sign-in response was missing tokens — try again.');
  }
  return {
    accessToken: access_token,
    refreshToken: refresh_token,
    expiresInSec: typeof expires_in === 'number' ? expires_in : 8 * 60 * 60,
    scopes: typeof scope === 'string' && scope ? scope.split(' ') : CLAUDE_SCOPES,
    subscriptionType:
      typeof body.subscription_type === 'string' ? body.subscription_type : undefined,
  };
}

/**
 * The `.credentials.json` document the Claude SDK/CLI reads on Linux. `expiresAt`
 * is a Unix epoch in milliseconds; carrying the refresh token is what lets the
 * CLI auto-renew the ~8h access token for long-running sessions.
 */
export function buildClaudeCredentialsJson(tokens: ExchangedTokens): string {
  const credentials = {
    claudeAiOauth: {
      accessToken: tokens.accessToken,
      refreshToken: tokens.refreshToken,
      expiresAt: Date.now() + tokens.expiresInSec * 1000,
      scopes: tokens.scopes,
      subscriptionType: tokens.subscriptionType ?? null,
      rateLimitTier: null,
    },
  };
  return `${JSON.stringify(credentials, null, 2)}\n`;
}

interface OAuthAttempt {
  key: string;
  userId: UserID;
  tenantId: TenantID | string;
  authUser: NonNullable<AuthenticatedParams['user']>;
  targetUnixUser: string | null;
  reportedUnixUser: string | null;
  phase: ClaudeOAuthStatus['phase'];
  verifier: string;
  state: string;
  verificationUrl: string;
  expiresAtMs: number;
  subscriptionType?: string;
  hint?: string;
  finishedAtMs?: number;
}

/** Minimal users-service surface — mirrors codex-auth-shared's structural typing. */
interface UsersServiceLike {
  get(id: UserID, params?: unknown): Promise<User>;
  patch(
    id: UserID,
    data: { agentic_auth_methods: AgenticAuthMethods },
    params?: unknown
  ): Promise<unknown>;
}

function statusOf(attempt: OAuthAttempt | undefined): ClaudeOAuthStatus {
  if (!attempt) return { phase: 'idle' };
  const base: ClaudeOAuthStatus = { phase: attempt.phase };
  if (attempt.phase === 'awaiting_code') {
    base.verificationUrl = attempt.verificationUrl;
    base.expiresAt = new Date(attempt.expiresAtMs).toISOString();
  }
  if (attempt.subscriptionType) base.subscriptionType = attempt.subscriptionType;
  if (attempt.hint) base.hint = attempt.hint;
  return base;
}

export function createClaudeOAuthService(app: AppLike, db: TenantScopeAwareDatabase) {
  const attempts = new Map<string, OAuthAttempt>();

  /**
   * Abandoned flows would otherwise grow the map forever on long-running
   * daemons — one entry per user who started and never finished a sign-in.
   */
  function pruneFinishedAttempts(): void {
    const cutoff = Date.now() - TERMINAL_ATTEMPT_TTL_MS;
    for (const [key, attempt] of attempts) {
      const terminal = attempt.phase !== 'awaiting_code';
      if (terminal && (attempt.finishedAtMs ?? 0) < cutoff) attempts.delete(key);
    }
  }

  async function requireContext(params?: AuthenticatedParams): Promise<{
    authUser: NonNullable<AuthenticatedParams['user']>;
    userId: UserID;
    tenantId: TenantID | string;
    key: string;
  }> {
    const authUser = params?.user;
    if (!authUser?.user_id) {
      throw new NotAuthenticated('Sign in before starting a Claude sign-in.');
    }
    const tenantId = getCurrentTenantId();
    if (!tenantId) throw new Error('Missing active tenant context for Claude OAuth');
    const userId = authUser.user_id as UserID;
    return { authUser, userId, tenantId, key: `${tenantId}:${userId}` };
  }

  async function persist(attempt: OAuthAttempt, tokens: ExchangedTokens): Promise<void> {
    await runWithTenantDatabaseScope(db, attempt.tenantId, async () => {
      try {
        await writeClaudeAuthViaExecutor(
          buildClaudeCredentialsJson(tokens),
          attempt.targetUnixUser,
          { reportedUnixUser: attempt.reportedUnixUser, userId: attempt.userId }
        );
      } catch (err) {
        // The error may carry sudo/bash stderr; log a class-level summary only
        // so token material never reaches daemon logs.
        console.error(
          `[ClaudeOAuth] Failed to write .credentials.json${
            attempt.targetUnixUser ? ` as ${attempt.targetUnixUser}` : ''
          }: ${err instanceof Error ? err.constructor.name : 'unknown error'}`
        );
        throw new BadRequest(
          'Could not write the Claude credentials file on the server. Check daemon logs and sudo configuration, or use an API key instead.'
        );
      }

      const usersService = app.service('users') as UsersServiceLike;
      const current = await usersService.get(attempt.userId, {
        user: attempt.authUser,
        authenticated: true,
      });
      await usersService.patch(
        attempt.userId,
        {
          agentic_auth_methods: {
            ...current.agentic_auth_methods,
            'claude-code': 'subscription',
          },
        },
        { user: attempt.authUser, authenticated: true }
      );
    });
  }

  return {
    async create(
      data: { code?: string },
      params?: AuthenticatedParams
    ): Promise<ClaudeOAuthStatus> {
      const { authUser, userId, tenantId, key } = await requireContext(params);
      pruneFinishedAttempts();

      const withTenantDatabase = <T>(work: (tenantDb: TenantScopedDatabase) => Promise<T>) =>
        runWithTenantDatabaseScope(db, tenantId, work);
      if (
        !(await withTenantDatabase((tenantDb) =>
          isTenantAgenticToolEnabled('claude-code', tenantDb)
        ))
      ) {
        throw new BadRequest('Claude is disabled for this workspace.');
      }

      // ── Submit step: a code was pasted back. Finish the existing attempt. ──
      if (data?.code?.trim()) {
        const attempt = attempts.get(key);
        if (attempt?.phase !== 'awaiting_code') {
          throw new BadRequest('No sign-in is in progress — start over to get a fresh link.');
        }
        if (Date.now() >= attempt.expiresAtMs) {
          attempt.phase = 'expired';
          attempt.finishedAtMs = Date.now();
          throw new BadRequest('The sign-in link expired — start over to get a fresh one.');
        }
        const { code, state } = splitPastedCode(data.code);
        // The pasted state must match ours (CSRF / mix-up defense). Fall back to
        // our own state when the page omitted it, per the paste-back contract.
        if (state && state !== attempt.state) {
          throw new BadRequest('The pasted code did not match this sign-in — start over.');
        }
        const tokens = await exchangeCodeForTokens(code, attempt.verifier, attempt.state);
        await persist(attempt, tokens);
        attempt.phase = 'success';
        attempt.subscriptionType = tokens.subscriptionType;
        attempt.finishedAtMs = Date.now();
        attempt.hint = tokens.subscriptionType
          ? `Signed in with Claude (${tokens.subscriptionType}).`
          : 'Signed in with Claude.';
        return statusOf(attempt);
      }

      // ── Start step: issue a fresh authorize URL, replacing any prior attempt. ──
      // Resolve the destination identity up front so a strict-mode user with no
      // unix_username fails fast instead of after approving in the browser.
      const identity = await resolveCodexUnixIdentity(
        userId,
        withTenantDatabase,
        app.get('config')
      );
      if (!identity.ok) {
        throw new BadRequest(
          `Cannot determine which Unix account should hold this Claude login: ${identity.message}`
        );
      }

      const pkce = generatePkce();
      const state = base64url(randomBytes(32));
      const attempt: OAuthAttempt = {
        key,
        userId,
        tenantId,
        authUser,
        targetUnixUser: identity.unixUser,
        reportedUnixUser: identity.reportedUnixUser,
        phase: 'awaiting_code',
        verifier: pkce.verifier,
        state,
        verificationUrl: buildAuthorizeUrl(pkce.challenge, state),
        expiresAtMs: Date.now() + ATTEMPT_LIFETIME_MS,
      };
      attempts.set(key, attempt);
      return statusOf(attempt);
    },

    async find(params?: AuthenticatedParams): Promise<ClaudeOAuthStatus> {
      const { key } = await requireContext(params);
      pruneFinishedAttempts();
      return statusOf(attempts.get(key));
    },
  };
}
