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
 * Where that attempt lives is the store's business — process memory for a
 * standalone daemon, PostgreSQL rows with sealed PKCE material and a one-shot
 * exchange claim when replicas must be able to finish each other's attempts.
 * See `claude-oauth-attempt-store.ts`.
 *
 * SECURITY CONTRACT: the browser carries the authorize URL and pasted
 * authorization code/state, but never tokens. Token material flows Anthropic
 * → daemon → the target user's filesystem only. Status responses carry the authorize URL and
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
import { writeClaudeAuthViaExecutor } from '../utils/executor-claude-auth.js';
import { sandboxManagedCredentialIsolationAvailable } from '../utils/sandbox-wrap.js';
import { CLAUDE_AUTH_TRUSTED_USER_MUTATION } from './claude-credential-mutation-trust.js';
import {
  type ClaudeOAuthAttemptContext,
  type ClaudeOAuthAttemptStore,
  type ClaudeOAuthExchangeClaim,
  InMemoryClaudeOAuthAttemptStore,
} from './claude-oauth-attempt-store.js';
import {
  type AppLike,
  CODEX_AUTH_DEFER_USER_REALTIME,
  resolveCodexCredentialRoute,
} from './codex-auth-shared.js';
import { markTrustedUserMutation } from './user-mutation-trust.js';

// Constants are the PROD OAuth config read out of the native `claude` binary
// bundled by the pinned SDK: package.json pins
// @anthropic-ai/claude-agent-sdk@0.3.259, whose manifest.json bundles claude
// CLI v2.1.259 (commit 9b549c8d). The URLs, client id, redirect, scope set, and
// JSON authorization-code exchange were re-checked in that native binary for
// this upgrade. The `-local-oauth` config (client id 22422756-…,
// localhost:8205) is dev-only and deliberately not used here.
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
// Scope string the CLI's claude.ai login sends. `user:file_upload` was added by
// the CLI bundled with Agent SDK 0.3.259; omitting it would leave a successful
// Agor sign-in less capable than `/login` in the same CLI.
const CLAUDE_SCOPES = [
  'user:profile',
  'user:inference',
  'user:sessions:claude_code',
  'user:mcp_servers',
  'user:file_upload',
];

const FETCH_TIMEOUT_MS = 15_000;
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
  // originally audited in v2.1.211). Required here since the daemon has no
  // loopback server.
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
    message: string,
    readonly retryAfterMs?: number
  ) {
    super(message);
  }
}

function retryAfterMs(response: Response): number | undefined {
  const value = response.headers.get('retry-after')?.trim();
  if (!value) return undefined;
  if (/^\d+$/.test(value)) return Number(value) * 1000;
  const date = Date.parse(value);
  return Number.isFinite(date) ? Math.max(0, date - Date.now()) : undefined;
}

export async function exchangeCodeForTokens(
  code: string,
  verifier: string,
  state: string
): Promise<ExchangedTokens> {
  // The CLI posts the exchange as JSON (no oauth beta header on this call).
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
 * - invalid credentials and other definitive 4xx responses are rejections;
 * - 408, 425, and 429 are transient/ambiguous and must not trigger a replay;
 * - network failures, 5xx, and malformed success bodies are ambiguous because
 *   the provider may already have rotated the refresh token.
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
    const transient = res.status >= 500 || [408, 425, 429].includes(res.status);
    throw new TokenExchangeError(
      transient ? 'ambiguous' : 'rejected',
      transient
        ? 'Claude had a server error refreshing this login. Try again later.'
        : 'Claude rejected this login refresh. Sign in again.',
      transient ? retryAfterMs(res) : undefined
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
 * Build the authorize URL from the attempt's PKCE verifier and state. The URL
 * and raw state are returned only by the start request and are never persisted;
 * durable rows retain only the state fingerprint and sealed verifier.
 */
export function claudeVerificationUrlFrom(verifier: string, state: string): string {
  return buildAuthorizeUrl(base64url(createHash('sha256').update(verifier).digest()), state);
}

export function createClaudeOAuthService(
  app: AppLike,
  db: TenantScopeAwareDatabase,
  /** Omitted for a standalone daemon, which keeps attempts in process memory. */
  store: ClaudeOAuthAttemptStore = new InMemoryClaudeOAuthAttemptStore(),
  runtimeIsolationAvailable: () => boolean = sandboxManagedCredentialIsolationAvailable
) {
  async function requireContext(params?: AuthenticatedParams): Promise<{
    authUser: NonNullable<AuthenticatedParams['user']>;
    userId: UserID;
    tenantId: TenantID | string;
    ctx: ClaudeOAuthAttemptContext;
  }> {
    const authUser = params?.user;
    if (!authUser?.user_id) {
      throw new NotAuthenticated('Sign in before starting a Claude sign-in.');
    }
    const tenantId = getCurrentTenantId();
    if (!tenantId) throw new Error('Missing active tenant context for Claude OAuth');
    const userId = authUser.user_id as UserID;
    return { authUser, userId, tenantId, ctx: { tenantId: String(tenantId), userId } };
  }

  const routeFor = (userId: UserID, tenantId: TenantID | string) =>
    resolveCodexCredentialRoute(
      userId,
      <T>(work: (tenantDb: TenantScopedDatabase) => Promise<T>) =>
        runWithTenantDatabaseScope(db, tenantId, work),
      app.get('config')
    );

  async function claimRouteIsCurrent(
    ctx: ClaudeOAuthAttemptContext,
    claim: Pick<ClaudeOAuthExchangeClaim, 'delegatedHomeKey' | 'claudeConfigDir'>
  ): Promise<boolean> {
    const identity = await routeFor(ctx.userId, ctx.tenantId);
    return (
      identity.ok &&
      identity.delegatedHomeKey === claim.delegatedHomeKey &&
      identity.claudeConfigDir === claim.claudeConfigDir
    );
  }

  /** Finalize under the store's tenant/user + filesystem generation authority. */
  async function persist(
    ctx: ClaudeOAuthAttemptContext,
    claim: ClaudeOAuthExchangeClaim,
    authUser: NonNullable<AuthenticatedParams['user']>,
    tokens: ExchangedTokens
  ): Promise<ClaudeOAuthStatus | false> {
    const outcome = await store.finalize(ctx, claim, async (generation) => {
      // The attempt fixed its destination home when it started. Re-resolve and
      // compare rather than trusting either value alone: a mid-flow identity
      // change would otherwise silently redirect the credential to a home the
      // user's sessions do not read.
      if (!(await claimRouteIsCurrent(ctx, claim))) {
        throw new BadRequest(
          'The execution home this sign-in would be saved to changed while you were approving it. ' +
            'Start over so the login is written to the right place.'
        );
      }

      try {
        await writeClaudeAuthViaExecutor(
          buildClaudeCredentialsJson(tokens),
          {
            delegatedHomeKey: claim.delegatedHomeKey,
            userId: ctx.userId,
            ...(claim.claudeConfigDir ? { claudeConfigDir: claim.claudeConfigDir } : {}),
          },
          generation
        );
      } catch (err) {
        // The error may carry launcher stderr; log a class-level summary only
        // so token material never reaches daemon logs.
        console.error(
          `[ClaudeOAuth] Failed to write .credentials.json${
            claim.delegatedHomeKey ? ` as ${claim.delegatedHomeKey}` : ''
          }: ${err instanceof Error ? err.constructor.name : 'unknown error'}`
        );
        throw new BadRequest(
          'Could not write the Claude credentials file on the server. Check daemon logs and sudo configuration, or use an API key instead.'
        );
      }

      // Flip to managed `subscription` AND drop any previously pasted token.
      // Task resolution will now read/refresh the canonical file daemon-side
      // and inject only its short-lived access token; `null` deletes just the
      // old pasted field and leaves other Claude settings intact.
      const usersService = app.service('users') as UsersServiceLike;
      // Select the explicit `managed_file` source and drop any previously
      // pasted CLAUDE_CODE_OAUTH_TOKEN. The source is the authority that makes
      // resolveTenantAgenticTool choose native on-disk auth; deleting the token
      // prevents a dormant higher-precedence env value from shadowing the
      // managed, refreshing file. `null` deletes only that credential field.
      try {
        const patchParams = {
          user: authUser,
          authenticated: true,
          [CLAUDE_AUTH_TRUSTED_USER_MUTATION]: true,
          [CODEX_AUTH_DEFER_USER_REALTIME]: true,
        };
        markTrustedUserMutation(patchParams, 'claude-auth');
        await usersService.patch(
          ctx.userId,
          {
            // Send only this tool's key. The users service merges against its
            // fresh row, so a concurrent Codex auth change is not overwritten
            // by a stale read/whole-map write.
            agentic_auth_methods: { 'claude-code': 'subscription' },
            agentic_credential_sources: { 'claude-code': 'managed_file' },
            agentic_tools: { 'claude-code': { CLAUDE_CODE_OAUTH_TOKEN: null } },
          },
          patchParams
        );
      } catch {
        // The file write may have committed. Never path-delete here: a newer
        // mutation on another replica may already own that same path. The
        // generation tombstone prevents older writers, and the attempt is
        // terminalized as ambiguous by the caller.
        throw new BadRequest(
          'Could not finish saving the Claude login metadata. Start over or disconnect to reconcile it.'
        );
      }
      return { value: true, subscriptionType: tokens.subscriptionType };
    });
    return outcome.outcome === 'committed' ? store.status(ctx, claim.attemptId) : false;
  }

  async function submit(
    ctx: ClaudeOAuthAttemptContext,
    authUser: NonNullable<AuthenticatedParams['user']>,
    attemptId: string | undefined,
    pasted: string
  ): Promise<ClaudeOAuthStatus> {
    // Validate the paste BEFORE reserving the attempt, so a malformed paste
    // leaves the attempt awaiting a real code for a legitimate retry.
    const { code, state } = parsePastedCode(pasted);

    // One atomic reservation decides who exchanges. A second submit — on this
    // replica or any other — loses here rather than racing a second exchange
    // of the same one-time code.
    const claimed = await store.claimForExchange(ctx, attemptId, state);
    switch (claimed.outcome) {
      case 'state_mismatch':
        throw new BadRequest('The pasted code did not match this sign-in — start over.');
      case 'expired':
        throw new BadRequest('The sign-in link expired — start over to get a fresh one.');
      case 'already_claimed':
        throw new BadRequest('This sign-in is already being completed — wait for it to finish.');
      case 'not_pending':
        throw new BadRequest('No sign-in is in progress — start over to get a fresh link.');
    }
    const claim = claimed.claim;

    // Avoid consuming a one-time provider code after a route mutation that won
    // before this submit. A mutation that wins after this check still
    // invalidates/fences finalization, which rechecks under credential authority.
    if (!(await claimRouteIsCurrent(ctx, claim))) {
      await store.finish(ctx, claim, {
        status: 'failed',
        failureCode: 'execution_home_changed',
        hint: 'The execution home changed — start over to save the login in the new home.',
      });
      throw new BadRequest(
        'The execution home changed while this sign-in was open. Start over before using the code.'
      );
    }

    let tokens: ExchangedTokens;
    try {
      tokens = await exchangeCodeForTokens(code, claim.verifier, claim.state);
    } catch (err) {
      // The code has now been POSTed to Anthropic, so this exact `code#state`
      // must never be exchanged again — a definitive 4xx killed it, and a
      // network/5xx/contract failure may have consumed it server-side. The
      // attempt goes terminal and the user starts over.
      const rejected = err instanceof TokenExchangeError && err.disposition === 'rejected';
      await store.finish(ctx, claim, {
        status: rejected ? 'failed' : 'ambiguous',
        failureCode: rejected ? 'provider_rejected_code' : 'exchange_failed',
        hint: rejected
          ? 'Claude rejected the sign-in code — start over to get a fresh link.'
          : 'Sign-in could not be completed and the code may be used up — start over to get a fresh link.',
      });
      throw err;
    }

    let persisted: ClaudeOAuthStatus | false;
    try {
      persisted = await persist(ctx, claim, authUser, tokens);
    } catch (err) {
      await store.finish(ctx, claim, {
        status: 'ambiguous',
        failureCode: 'credential_persistence_ambiguous',
        hint: 'Signing in succeeded but saving the login could not be confirmed — start over or disconnect.',
      });
      throw err;
    }
    // A superseded or logged-out attempt wrote nothing; report whatever the
    // store now considers current rather than claiming success.
    if (!persisted) return store.status(ctx, claim.attemptId);

    return persisted;
  }

  return {
    async create(
      data: { code?: string; attemptId?: string },
      params?: AuthenticatedParams
    ): Promise<ClaudeOAuthStatus> {
      const { authUser, userId, tenantId, ctx } = await requireContext(params);
      assertClaudeSubscriptionOAuthEnabled(app);

      if (
        !(await runWithTenantDatabaseScope(db, tenantId, (tenantDb) =>
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
        if (typeof data.attemptId !== 'string' || !data.attemptId) {
          throw new BadRequest('The Claude sign-in attempt id is required. Start over.');
        }
        return submit(ctx, authUser, data.attemptId, data.code);
      }

      // ── Start step: issue a fresh authorize URL, replacing any prior attempt. ──
      // Resolve the destination identity up front so a user with no resolvable
      // execution home fails fast instead of after approving in the browser.
      const identity = await routeFor(userId, tenantId);
      if (!identity.ok) {
        throw new BadRequest(
          `Cannot determine which Unix account should hold this Claude login: ${identity.message}`
        );
      }

      const pkce = generatePkce();
      const state = base64url(randomBytes(32));
      const started = await store.start(ctx, {
        verifier: pkce.verifier,
        state,
        delegatedHomeKey: identity.delegatedHomeKey,
        ...(identity.claudeConfigDir ? { claudeConfigDir: identity.claudeConfigDir } : {}),
        validateRoute: async () => {
          const current = await routeFor(userId, tenantId);
          if (
            !current.ok ||
            current.delegatedHomeKey !== identity.delegatedHomeKey ||
            current.claudeConfigDir !== identity.claudeConfigDir
          ) {
            throw new BadRequest(
              'The execution home changed before sign-in started. Start again to use the current home.'
            );
          }
          return true;
        },
        buildVerificationUrl: claudeVerificationUrlFrom,
      });
      return {
        phase: 'awaiting_code',
        attemptId: started.attemptId,
        verificationUrl: started.verificationUrl,
        expiresAt: new Date(started.expiresAtMs).toISOString(),
      };
    },

    async find(params?: AuthenticatedParams): Promise<ClaudeOAuthStatus> {
      const { ctx } = await requireContext(params);
      assertClaudeSubscriptionOAuthEnabled(app);
      const attemptId = (params?.query as { attemptId?: string } | undefined)?.attemptId;
      return store.status(ctx, attemptId);
    },
  };
}
