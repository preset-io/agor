/**
 * Claude Subscription OAuth Sign-In Service
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

import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import {
  hasContainedClaudeRuntimeCredentials,
  isClaudeSubscriptionOAuthEnabled,
  isTenantAgenticToolEnabled,
} from '@agor/core/config';
import {
  getCurrentTenantId,
  runWithTenantDatabaseScope,
  type TenantScopeAwareDatabase,
  type TenantScopedDatabase,
} from '@agor/core/db';
import { BadRequest, NotAuthenticated, Unavailable } from '@agor/core/feathers';
import type {
  AgenticAuthMethods,
  AgenticCredentialSources,
  AuthenticatedParams,
  ClaudeOAuthStatus,
  TenantID,
  UserID,
} from '@agor/core/types';
import {
  deleteClaudeAuthViaExecutor,
  writeClaudeAuthViaExecutor,
} from '../utils/executor-claude-auth.js';
import { sandboxManagedCredentialIsolationAvailable } from '../utils/sandbox-wrap.js';
import { type AppLike, resolveCodexCredentialRoute } from './codex-auth-shared.js';
import { markTrustedUserMutation } from './user-mutation-trust.js';

// Constants are the PROD OAuth config (`yol`) read out of the native `claude`
// binary bundled by the pinned SDK: package.json pins
// @anthropic-ai/claude-agent-sdk@0.3.197, whose manifest.json bundles claude
// CLI v2.1.197 (commit c8fd8048). The prod config is identical in the installed
// CLI v2.1.211, which was byte-inspected: config object at file offset
// ~237512852 (`yol={...}`), login authorize builder at ~101457400, token
// exchange at ~101464300. The `-local-oauth` config (client id
// 22422756-…, localhost:8205) is dev-only and deliberately not used here.
/** PROD OAuth client id (`yol.CLIENT_ID`). Fixed and public across installs. */
const CLAUDE_CLIENT_ID = '9d1c250a-e61b-44d9-88ed-5944d1962f5e';
// Subscription (Claude Pro/Max) authorize endpoint = `yol.CLAUDE_AI_AUTHORIZE_URL`.
// Console/API-billing login uses `yol.CONSOLE_AUTHORIZE_URL`
// (https://platform.claude.com/oauth/authorize); the subscription path is ours.
const CLAUDE_AUTHORIZE_URL = 'https://claude.com/cai/oauth/authorize';
// `yol.TOKEN_URL`. The old console.anthropic.com host belonged to pre-rename
// SDKs; prod issues and exchanges against platform.claude.com.
const CLAUDE_TOKEN_URL = 'https://platform.claude.com/v1/oauth/token';
// `yol.MANUAL_REDIRECT_URL` — the paste-back redirect. The CLI's own browser
// flow can instead use a loopback http://localhost:{port}/callback; the daemon
// runs no loopback server, so it uses the manual redirect, and the token is
// issued for exactly this redirect + client id, so both must match byte-for-byte.
const CLAUDE_REDIRECT_URI = 'https://platform.claude.com/oauth/code/callback';
// Scope string the CLI's claude.ai login sends (login builder at offset
// ~101458000: "user:profile user:inference user:sessions:claude_code user:mcp_servers").
const CLAUDE_SCOPES = [
  'user:profile',
  'user:inference',
  'user:sessions:claude_code',
  'user:mcp_servers',
];

const FETCH_TIMEOUT_MS = 15_000;
/** How long a daemon-side attempt keeps its verifier/state before it must restart. */
const ATTEMPT_LIFETIME_MS = 10 * 60 * 1000;
/** How long a finished attempt stays queryable before eviction. */
const TERMINAL_ATTEMPT_TTL_MS = 60 * 60 * 1000;
const MAX_PASTED_CODE_LENGTH = 16 * 1024;

function assertClaudeSubscriptionOAuthEnabled(app: AppLike): void {
  if (isClaudeSubscriptionOAuthEnabled(app.get('config'))) return;
  throw new Unavailable(
    'Claude subscription sign-in is disabled on this deployment. Use an API key or a pasted subscription token.',
    { code: 'CLAUDE_SUBSCRIPTION_OAUTH_DISABLED' }
  );
}

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
export function generatePkce(): PkcePair {
  const verifier = base64url(randomBytes(32));
  const challenge = base64url(createHash('sha256').update(verifier).digest());
  return { verifier, challenge };
}

export function buildAuthorizeUrl(challenge: string, state: string): string {
  const url = new URL(CLAUDE_AUTHORIZE_URL);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('client_id', CLAUDE_CLIENT_ID);
  url.searchParams.set('redirect_uri', CLAUDE_REDIRECT_URI);
  url.searchParams.set('scope', CLAUDE_SCOPES.join(' '));
  url.searchParams.set('code_challenge', challenge);
  url.searchParams.set('code_challenge_method', 'S256');
  url.searchParams.set('state', state);
  // `code=true` selects the code-display (paste-back) page instead of a silent
  // loopback redirect — the CLI sets it for its manual flow (authorize builder
  // offset ~101457400). Required here since the daemon has no loopback server.
  url.searchParams.set('code', 'true');
  return url.toString();
}

export interface ExchangedTokens {
  accessToken: string;
  refreshToken: string;
  expiresInSec: number;
  scopes: string[];
  subscriptionType?: string;
}

/**
 * Parse the pasted `CODE#STATE`. State is REQUIRED and bound to the attempt: a
 * bare code (no state, or empty state) is rejected rather than exchanged against
 * the stored state, so an attacker who only has a victim's code cannot complete
 * a sign-in the victim's browser started. Throws `BadRequest` on any deviation
 * (missing/empty halves, more than one `#`).
 */
export function parsePastedCode(pasted: string): { code: string; state: string } {
  const parts = pasted.trim().split('#');
  if (parts.length !== 2 || !parts[0] || !parts[1]) {
    throw new BadRequest(
      'Paste the whole code shown after approval (it looks like `CODE#STATE`) — start over to get a fresh one.'
    );
  }
  return { code: parts[0], state: parts[1] };
}

/** Constant-time string equality (avoids leaking the state via compare timing). */
export function constantTimeEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a, 'utf8');
  const bufB = Buffer.from(b, 'utf8');
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}

/** Generous upper bound on a plausible token lifetime (> the 1-year setup-token). */
const MAX_EXPIRES_IN_SEC = 400 * 24 * 60 * 60;

/**
 * A failed code-for-token exchange, tagged with what it means for the pasted
 * code. The authorization code is one-time and state-bound, so NEITHER
 * disposition is replayable — both force the user to start a fresh attempt — but
 * the tag drives the user-facing hint and lets `submit` reason explicitly rather
 * than sniff message text:
 *
 * - `rejected`: Anthropic returned a definitive 4xx BEFORE issuing tokens (bad/
 *   expired/already-used code). The code was not consumed here but is now dead.
 * - `ambiguous`: the request may have reached Anthropic and consumed the code
 *   even though we got no usable tokens back — a network timeout / connection
 *   reset, a 5xx, or a 2xx whose body broke the token contract. Replaying the
 *   same code could double-spend a code Anthropic already burned.
 *
 * Extends `BadRequest` so it still surfaces as a clean 400 with safe text.
 */
export class TokenExchangeError extends BadRequest {
  constructor(
    readonly disposition: 'rejected' | 'ambiguous',
    message: string
  ) {
    super(message);
  }
}

export async function exchangeCodeForTokens(
  code: string,
  verifier: string,
  state: string
): Promise<ExchangedTokens> {
  // The CLI posts the exchange as JSON (no oauth beta header on this call);
  // token exchange at binary offset ~101464300 uses application/json.
  let res: Response;
  try {
    res = await fetchWithTimeout(CLAUDE_TOKEN_URL, {
      method: 'POST',
      redirect: 'error',
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
  } catch {
    // Timeout (AbortError), connection reset, DNS/TLS failure — the POST may have
    // reached Anthropic and consumed the one-time code before the connection
    // dropped. Ambiguous: never replay this code.
    throw new TokenExchangeError(
      'ambiguous',
      'Could not reach Claude to finish signing in — start over to get a fresh code.'
    );
  }
  if (!res.ok) {
    // 4xx is a definitive rejection before any token was issued: the code is dead
    // (single-use + state-bound), so start over. 5xx may have consumed the code
    // server-side while failing to return it — ambiguous, equally non-replayable.
    throw new TokenExchangeError(
      res.status >= 500 ? 'ambiguous' : 'rejected',
      res.status >= 500
        ? 'Claude had a server error finishing sign-in — start over to get a fresh code.'
        : 'Claude rejected the sign-in code — start over and paste a fresh code.'
    );
  }

  let body: Record<string, unknown>;
  try {
    body = (await res.json()) as Record<string, unknown>;
  } catch {
    throw new TokenExchangeError(
      'ambiguous',
      'Claude sign-in returned an unreadable response. Start over to get a fresh code.'
    );
  }
  const { access_token, refresh_token, expires_in, scope } = body;
  // A 2xx with a malformed body is a provider-contract break: Anthropic accepted
  // (and thus consumed) the code but we cannot use the response. Surface a
  // sanitized ambiguous failure rather than fabricating an expiry that would
  // strand the session on a token we cannot refresh — and never replay the code.
  if (
    typeof access_token !== 'string' ||
    !access_token.trim() ||
    typeof refresh_token !== 'string' ||
    !refresh_token.trim()
  ) {
    throw new TokenExchangeError(
      'ambiguous',
      'Claude sign-in response was missing tokens — start over to get a fresh code.'
    );
  }
  if (
    typeof expires_in !== 'number' ||
    !Number.isFinite(expires_in) ||
    expires_in <= 0 ||
    expires_in > MAX_EXPIRES_IN_SEC
  ) {
    throw new TokenExchangeError(
      'ambiguous',
      'Claude sign-in response had an invalid expiry — start over to get a fresh code.'
    );
  }
  return {
    accessToken: access_token,
    refreshToken: refresh_token,
    expiresInSec: expires_in,
    scopes: typeof scope === 'string' && scope ? scope.split(' ') : CLAUDE_SCOPES,
    subscriptionType:
      typeof body.subscription_type === 'string' ? body.subscription_type : undefined,
  };
}

/**
 * Refresh a managed Claude grant without exposing the long-lived refresh token
 * to the provider runtime. The POST deliberately has the same rejected versus
 * ambiguous taxonomy as the one-shot code exchange:
 *
 * - definitive 4xx responses (including `invalid_grant`) are rejections;
 * - network failures, 408/425/429 throttling or timeout responses, 5xx, and
 *   malformed success bodies are ambiguous because the provider may already
 *   have rotated the refresh token. `Retry-After` must not trigger an automatic
 *   replay of a possibly consumed refresh token within the launch.
 *
 * Callers must never clear the canonical file or persisted source for either
 * disposition. An ambiguous refresh is never replayed within the launch.
 */
export async function refreshClaudeTokens(
  refreshToken: string,
  current: Pick<ExchangedTokens, 'scopes' | 'subscriptionType'>
): Promise<ExchangedTokens> {
  let res: Response;
  try {
    res = await fetchWithTimeout(CLAUDE_TOKEN_URL, {
      method: 'POST',
      redirect: 'error',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        grant_type: 'refresh_token',
        refresh_token: refreshToken,
        client_id: CLAUDE_CLIENT_ID,
        scope: (current.scopes.length > 0 ? current.scopes : CLAUDE_SCOPES).join(' '),
      }),
    });
  } catch {
    throw new TokenExchangeError(
      'ambiguous',
      'Could not reach Claude to refresh this login. Try again later.'
    );
  }
  if (!res.ok) {
    const ambiguous = res.status >= 500 || [408, 425, 429].includes(res.status);
    throw new TokenExchangeError(
      ambiguous ? 'ambiguous' : 'rejected',
      ambiguous
        ? 'Claude login refresh is temporarily unavailable. Try again later.'
        : 'Claude rejected this login refresh. Sign in again.'
    );
  }

  let body: Record<string, unknown>;
  try {
    body = (await res.json()) as Record<string, unknown>;
  } catch {
    throw new TokenExchangeError(
      'ambiguous',
      'Claude returned an unreadable login refresh response. Try again later.'
    );
  }
  const { access_token, refresh_token, expires_in, scope } = body;
  if (typeof access_token !== 'string' || !access_token.trim()) {
    throw new TokenExchangeError(
      'ambiguous',
      'Claude login refresh returned no access token. Try again later.'
    );
  }
  if (
    typeof expires_in !== 'number' ||
    !Number.isFinite(expires_in) ||
    expires_in <= 0 ||
    expires_in > MAX_EXPIRES_IN_SEC
  ) {
    throw new TokenExchangeError(
      'ambiguous',
      'Claude login refresh returned an invalid expiry. Try again later.'
    );
  }
  if (refresh_token !== undefined && (typeof refresh_token !== 'string' || !refresh_token.trim())) {
    throw new TokenExchangeError(
      'ambiguous',
      'Claude login refresh returned an invalid refresh token. Try again later.'
    );
  }
  return {
    accessToken: access_token,
    // Claude currently rotates this value, but OAuth permits a refresh response
    // to omit it. In that case the previous refresh token remains authoritative.
    refreshToken: typeof refresh_token === 'string' ? refresh_token : refreshToken,
    expiresInSec: expires_in,
    scopes:
      typeof scope === 'string' && scope
        ? scope.split(' ')
        : current.scopes.length > 0
          ? current.scopes
          : CLAUDE_SCOPES,
    subscriptionType:
      typeof body.subscription_type === 'string'
        ? body.subscription_type
        : current.subscriptionType,
  };
}

/**
 * The canonical `.credentials.json` document stored for a managed Claude login.
 * `expiresAt` is a Unix epoch in milliseconds. Only the daemon reads and
 * refreshes this document; contained task runtimes receive its short-lived
 * access token through the sensitive executor environment channel.
 */
export function buildClaudeCredentialsJson(tokens: ExchangedTokens, nowMs = Date.now()): string {
  const credentials = {
    claudeAiOauth: {
      accessToken: tokens.accessToken,
      refreshToken: tokens.refreshToken,
      expiresAt: nowMs + tokens.expiresInSec * 1000,
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
  delegatedHomeKey: string | null;
  claudeConfigDir?: string;
  phase: ClaudeOAuthStatus['phase'];
  verifier: string;
  state: string;
  verificationUrl: string;
  expiresAtMs: number;
  subscriptionType?: string;
  hint?: string;
  finishedAtMs?: number;
  /** Set when a newer attempt replaces this one, so an in-flight submit bails. */
  cancelled: boolean;
}

/** Minimal users-service surface — mirrors codex-auth-shared's structural typing. */
interface UsersServiceLike {
  patch(
    id: UserID,
    data: {
      agentic_auth_methods?: AgenticAuthMethods;
      agentic_credential_sources?: AgenticCredentialSources;
      // `null` deletes a stored credential field (applyAgenticToolsPatch), used
      // to drop a previously pasted CLAUDE_CODE_OAUTH_TOKEN on OAuth success.
      agentic_tools?: Partial<Record<'claude-code', Record<string, string | null>>>;
    },
    params?: unknown
  ): Promise<unknown>;
}

/**
 * Process-local authority for the standalone Claude credential boundary.
 * Provider exchange never holds this lock; start, final persistence, and logout
 * do, so a slow writer cannot land after a newer attempt or sign-out.
 */
export interface ClaudeCredentialMutationCoordinator {
  runCredentialMutation<T>(key: string, work: (generation: number) => Promise<T>): Promise<T>;
  invalidate(key: string, hint: string): void;
}

/**
 * Credential homes are user-private only in the exact persistent-per-user
 * topology. Shared/simple layouts intentionally retain one global authority
 * key because different users can address the same physical file.
 */
export function claudeCredentialMutationKey(
  config: Pick<import('@agor/core/config').AgorConfig, 'execution'>,
  tenantId: string,
  userId: UserID
): string {
  return hasContainedClaudeRuntimeCredentials(config) ? `${tenantId}:${userId}` : 'shared-home';
}

export class InMemoryClaudeOAuthCoordinator implements ClaudeCredentialMutationCoordinator {
  readonly attempts = new Map<string, OAuthAttempt>();
  private readonly mutationTails = new Map<string, Promise<void>>();
  private lastGeneration = 0;

  async runCredentialMutation<T>(
    key: string,
    work: (generation: number) => Promise<T>
  ): Promise<T> {
    const previous = this.mutationTails.get(key) ?? Promise.resolve();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const tail = previous.catch(() => undefined).then(() => gate);
    this.mutationTails.set(key, tail);
    await previous.catch(() => undefined);
    try {
      // Persisted credential generation fences also protect delegated executor
      // writes that outlive their request. Time supplies restart monotonicity;
      // the local counter supplies uniqueness within one millisecond.
      const generation = Math.max(Date.now() * 1_000, this.lastGeneration + 1);
      this.lastGeneration = generation;
      return await work(generation);
    } finally {
      release();
      if (this.mutationTails.get(key) === tail) this.mutationTails.delete(key);
    }
  }

  invalidate(key: string, hint: string): void {
    const attempt = this.attempts.get(key);
    if (!attempt) return;
    attempt.cancelled = true;
    finishAttempt(attempt, 'error', hint);
  }
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

function finishAttempt(
  attempt: OAuthAttempt,
  phase: ClaudeOAuthStatus['phase'],
  hint?: string
): void {
  attempt.phase = phase;
  attempt.finishedAtMs = Date.now();
  attempt.verifier = '';
  attempt.state = '';
  if (hint) attempt.hint = hint;
}

export function createClaudeOAuthService(
  app: AppLike,
  db: TenantScopeAwareDatabase,
  coordinator = new InMemoryClaudeOAuthCoordinator(),
  runtimeIsolationAvailable: () => boolean = sandboxManagedCredentialIsolationAvailable
) {
  const { attempts } = coordinator;

  /** True while `attempt` is still the live attempt for its user. */
  function isCurrent(attempt: OAuthAttempt): boolean {
    return !attempt.cancelled && attempts.get(attempt.key) === attempt;
  }

  /**
   * Move an attempt to a terminal phase and drop its secrets promptly — the
   * verifier and state are useless after the attempt ends and should not linger
   * in memory until the TTL sweep evicts the record.
   */
  function finish(attempt: OAuthAttempt, phase: ClaudeOAuthStatus['phase'], hint?: string): void {
    finishAttempt(attempt, phase, hint);
  }

  /**
   * Expire overdue awaiting-code attempts, then evict long-finished ones.
   * Without the expiry step an abandoned link would report `awaiting_code`
   * forever and never be pruned. `exchanging` attempts are left alone — an
   * in-flight exchange is bounded by the fetch timeout, not this clock.
   */
  function expireAndPrune(): void {
    const now = Date.now();
    const cutoff = now - TERMINAL_ATTEMPT_TTL_MS;
    for (const [key, attempt] of attempts) {
      if (attempt.phase === 'awaiting_code' && now >= attempt.expiresAtMs) {
        finish(attempt, 'expired', 'The sign-in link expired — start over to get a fresh one.');
      }
      const terminal = attempt.phase !== 'awaiting_code' && attempt.phase !== 'exchanging';
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
    await coordinator.runCredentialMutation(
      claudeCredentialMutationKey(app.get('config'), attempt.tenantId, attempt.userId),
      async (generation) => {
        // Final ownership gate immediately before the write: a replacement
        // attempt registered during the exchange must not have its freshly written
        // credential clobbered by this older one.
        if (!isCurrent(attempt)) return;

        // Re-resolve immediately before handling tokens. An admin may have moved
        // the user's execution home while the browser was approving. Never write
        // a credential to the stale (possibly reassigned) home pinned at start.
        const withTenantDatabase = <T>(work: (tenantDb: TenantScopedDatabase) => Promise<T>) =>
          runWithTenantDatabaseScope(db, attempt.tenantId, work);
        const identity = await resolveCodexCredentialRoute(
          attempt.userId,
          withTenantDatabase,
          app.get('config')
        );
        if (
          !identity.ok ||
          identity.delegatedHomeKey !== attempt.delegatedHomeKey ||
          identity.claudeConfigDir !== attempt.claudeConfigDir
        ) {
          throw new BadRequest(
            'The execution home for this Claude login changed while signing in. Start over.'
          );
        }

        try {
          await writeClaudeAuthViaExecutor(
            buildClaudeCredentialsJson(tokens),
            {
              delegatedHomeKey: identity.delegatedHomeKey,
              userId: identity.userId,
              ...(identity.claudeConfigDir ? { claudeConfigDir: identity.claudeConfigDir } : {}),
            },
            generation
          );
        } catch (err) {
          // The error may carry sudo/bash stderr; log a class-level summary only
          // so token material never reaches daemon logs.
          console.error(
            `[ClaudeOAuth] Failed to write .credentials.json${
              attempt.delegatedHomeKey ? ` as ${attempt.delegatedHomeKey}` : ''
            }: ${err instanceof Error ? err.constructor.name : 'unknown error'}`
          );
          throw new BadRequest(
            'Could not write the Claude credentials file on the server. Check daemon logs, or use an API key instead.'
          );
        }

        // Flip to managed `subscription` AND drop any previously pasted token.
        // Task resolution will now read/refresh the canonical file daemon-side
        // and inject only its short-lived access token; `null` deletes just the
        // old pasted field and leaves other Claude settings intact.
        const usersService = app.service('users') as UsersServiceLike;
        try {
          const patchParams = { user: attempt.authUser, authenticated: true };
          markTrustedUserMutation(patchParams, 'claude-auth');
          await usersService.patch(
            attempt.userId,
            {
              // Send only this tool's method; UsersService merges against its fresh
              // row so concurrent Codex changes cannot be overwritten.
              agentic_auth_methods: { 'claude-code': 'subscription' },
              agentic_credential_sources: { 'claude-code': 'managed_file' },
              agentic_tools: { 'claude-code': { CLAUDE_CODE_OAUTH_TOKEN: null } },
            },
            patchParams
          );
        } catch (error) {
          // The filesystem write precedes the short metadata transaction. If its
          // write gate or DB commit fails, remove the just-written generation so
          // no hidden credential remains active while metadata says API-key.
          try {
            await deleteClaudeAuthViaExecutor(
              {
                delegatedHomeKey: identity.delegatedHomeKey,
                userId: identity.userId,
                ...(identity.claudeConfigDir ? { claudeConfigDir: identity.claudeConfigDir } : {}),
              },
              generation
            );
          } catch (cleanupError) {
            console.error(
              `[ClaudeOAuth] Credential compensation failed: ${
                cleanupError instanceof Error ? cleanupError.constructor.name : 'unknown error'
              }`
            );
          }
          // Preserve the tenant freeze/write-gate status so callers receive the
          // required 503. Other repository/driver errors are internal details and
          // must not be reflected to the browser.
          if (error instanceof Unavailable) throw error;
          throw new BadRequest(
            'Could not finish saving the Claude login. Start over, or ask an administrator to check daemon logs.'
          );
        }
      }
    );
  }

  async function submit(key: string, pasted: string): Promise<ClaudeOAuthStatus> {
    const attempt = attempts.get(key);
    if (attempt?.phase !== 'awaiting_code') {
      throw new BadRequest('No sign-in is in progress — start over to get a fresh link.');
    }
    if (Date.now() >= attempt.expiresAtMs) {
      finish(attempt, 'expired', 'The sign-in link expired — start over to get a fresh one.');
      throw new BadRequest('The sign-in link expired — start over to get a fresh one.');
    }
    // Validate the paste BEFORE reserving the attempt, so a malformed/wrong-state
    // paste leaves the attempt in `awaiting_code` for a legitimate retry.
    const { code, state } = parsePastedCode(pasted);
    if (!constantTimeEqual(state, attempt.state)) {
      throw new BadRequest('The pasted code did not match this sign-in — start over.');
    }

    // Reserve the attempt before the network round-trip: a concurrent submit now
    // sees `exchanging` (not `awaiting_code`) and is rejected instead of racing a
    // second exchange of the same code.
    const { verifier, state: attemptState } = attempt;
    attempt.phase = 'exchanging';

    let tokens: ExchangedTokens;
    try {
      tokens = await exchangeCodeForTokens(code, verifier, attemptState);
    } catch (err) {
      // The code has now been POSTed to Anthropic, so this exact `code#state` must
      // never be exchanged again — a definitive 4xx killed it, and a network/5xx/
      // contract failure may have consumed it server-side. So we do NOT return to
      // `awaiting_code` (which previously let the user replay the same, possibly
      // spent, code); the attempt goes terminal and the user starts over.
      // Malformed-paste / wrong-state submissions never reach here — they are
      // rejected earlier, while the attempt is still `awaiting_code`.
      if (isCurrent(attempt)) {
        const rejected = err instanceof TokenExchangeError && err.disposition === 'rejected';
        finish(
          attempt,
          'error',
          rejected
            ? 'Claude rejected the sign-in code — start over to get a fresh link.'
            : 'Sign-in could not be completed and the code may be used up — start over to get a fresh link.'
        );
      }
      throw err;
    }

    // Ownership gate after the exchange (persist re-checks again right before the
    // write): a replacement `create({})` during the exchange wins.
    if (!isCurrent(attempt)) return statusOf(attempts.get(key));

    try {
      await persist(attempt, tokens);
    } catch (err) {
      if (isCurrent(attempt)) {
        finish(attempt, 'error', 'Signing in succeeded but saving the login failed — try again.');
      }
      throw err;
    }

    if (!isCurrent(attempt)) return statusOf(attempts.get(key));
    finish(
      attempt,
      'success',
      tokens.subscriptionType
        ? `Signed in with Claude (${tokens.subscriptionType}).`
        : 'Signed in with Claude.'
    );
    attempt.subscriptionType = tokens.subscriptionType;
    return statusOf(attempt);
  }

  return {
    async create(
      data: { code?: string },
      params?: AuthenticatedParams
    ): Promise<ClaudeOAuthStatus> {
      const { authUser, userId, tenantId, key } = await requireContext(params);
      assertClaudeSubscriptionOAuthEnabled(app);
      expireAndPrune();

      const withTenantDatabase = <T>(work: (tenantDb: TenantScopedDatabase) => Promise<T>) =>
        runWithTenantDatabaseScope(db, tenantId, work);
      if (
        !(await withTenantDatabase((tenantDb) =>
          isTenantAgenticToolEnabled('claude-code', tenantDb)
        ))
      ) {
        throw new BadRequest('Claude is disabled for this workspace.');
      }
      const config = app.get('config');
      if (!hasContainedClaudeRuntimeCredentials(config)) {
        throw new BadRequest(
          'Claude subscription sign-in requires a contained per-user sandbox. Use an API key or pasted subscription token in this execution mode.'
        );
      }
      if (!runtimeIsolationAvailable()) {
        throw new BadRequest(
          'Claude subscription sign-in requires verified bubblewrap isolation with a private PID namespace on this host. Use an API key or pasted subscription token.'
        );
      }

      // ── Submit step: a code was pasted back. Finish the existing attempt. ──
      if (data && Object.hasOwn(data, 'code')) {
        if (
          typeof data.code !== 'string' ||
          !data.code.trim() ||
          data.code.length > MAX_PASTED_CODE_LENGTH
        ) {
          throw new BadRequest('Paste the complete Claude authorization code, or start over.');
        }
        return submit(key, data.code);
      }

      // ── Start step: issue a fresh authorize URL, replacing any prior attempt. ──
      return coordinator.runCredentialMutation(
        claudeCredentialMutationKey(config, tenantId, userId),
        async () => {
          // Resolve before invalidating the old attempt. A transient routing
          // failure must not destroy an otherwise valid paste-back flow.
          const identity = await resolveCodexCredentialRoute(userId, withTenantDatabase, config);
          if (!identity.ok) {
            throw new BadRequest(
              `Cannot determine which Unix account should hold this Claude login: ${identity.message}`
            );
          }

          const prior = attempts.get(key);
          if (prior) {
            prior.cancelled = true;
            finish(prior, 'error', 'This sign-in was replaced by a newer attempt.');
          }

          const pkce = generatePkce();
          const state = base64url(randomBytes(32));
          const attempt: OAuthAttempt = {
            key,
            userId,
            tenantId,
            authUser,
            delegatedHomeKey: identity.delegatedHomeKey,
            ...(identity.claudeConfigDir ? { claudeConfigDir: identity.claudeConfigDir } : {}),
            phase: 'awaiting_code',
            verifier: pkce.verifier,
            state,
            verificationUrl: buildAuthorizeUrl(pkce.challenge, state),
            expiresAtMs: Date.now() + ATTEMPT_LIFETIME_MS,
            cancelled: false,
          };
          attempts.set(key, attempt);
          return statusOf(attempt);
        }
      );
    },

    async find(params?: AuthenticatedParams): Promise<ClaudeOAuthStatus> {
      const { key } = await requireContext(params);
      assertClaudeSubscriptionOAuthEnabled(app);
      expireAndPrune();
      return statusOf(attempts.get(key));
    },
  };
}
