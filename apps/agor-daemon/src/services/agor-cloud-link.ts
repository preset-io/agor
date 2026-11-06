/**
 * "Sign in to Agor Cloud" on a self-hosted daemon (contract in
 * `@agor/core/types` agor-cloud.ts).
 *
 * `start` issues a single-use state bound to the caller and their return URL;
 * `complete` checks it, checks the workspace host against the configured
 * suffixes, and redeems the one-time launch code at that workspace's existing
 * `/auth/launch`. The workspace session it returns (15 min access, 30 day
 * refresh) is sealed under the master secret in `app_variables`, one record
 * per user, and never leaves this process except as a Bearer to that same
 * workspace. Disconnect, Done, or 7 days without use (checked when next used)
 * forget it; the session itself expires after 30 days.
 *
 * Every change is a compare-and-set on the stored ciphertext (freshly salted
 * on each write, so it is a row version): a late refresh or sign-in never
 * restores a link that was disconnected or replaced. Each sign-in gets a new
 * `generation`, kept across refreshes, that transfers bind to.
 */

import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import type { AgorConfig } from '@agor/core/config';
import { AppVariableRepository, runWithTenantDatabaseScope } from '@agor/core/db';
import { BadRequest, Conflict, NotAuthenticated, Unavailable } from '@agor/core/feathers';
import {
  AGOR_CLOUD,
  type AgorCloudLinkCompleteRequest,
  type AgorCloudLinkPublic,
  type AgorCloudLinkStartResult,
  type AgorCloudLinkStatus,
  agorCloudReturnToProblem,
  type DeepReadonly,
} from '@agor/core/types';
import type { AgorPackServiceContext } from './agor-pack-export.js';

const LAUNCH_TIMEOUT_MS = 10_000;
/** Refresh the workspace access token when less than this is left. */
const REFRESH_MARGIN_MS = 60_000;
const TOUCH_INTERVAL_MS = 5 * 60_000;
const CAS_ATTEMPTS = 5;
export const AGOR_CLOUD_LINK_CHANGED = 'Cloud connection changed; start again.';

export type AgorCloudLinkContext = Pick<
  AgorPackServiceContext,
  'db' | 'config' | 'tenantId' | 'user'
>;

interface PendingSignIn {
  state_sha256: string;
  return_to: string;
  expires_at: number;
}

interface StoredLink extends AgorCloudLinkPublic {
  /** New on every sign-in, kept across refreshes: what a transfer is bound to. */
  generation: string;
  cloud_user_id: string | null;
  access_token: string;
  refresh_token: string;
  access_expires_at: number;
  last_used_at: number;
}

interface LinkRecord {
  pending?: PendingSignIn;
  /** Claim id of the sign-in currently redeeming its launch code. */
  completing?: string;
  link?: StoredLink;
}

/** A link usable as a workspace Bearer. */
export interface AgorCloudSession {
  workspaceUrl: string;
  accessToken: string;
  generation: string;
  cloudUserId: string | null;
}

export interface AgorCloudSettings {
  consoleUrl: string;
  workspaceHostSuffixes: string[];
}

export function resolveAgorCloudSettings(config: DeepReadonly<AgorConfig>): AgorCloudSettings {
  const consoleUrl = (config.agor_cloud?.console_url ?? AGOR_CLOUD.defaultConsoleUrl).replace(
    /\/+$/,
    ''
  );
  const suffixes = config.agor_cloud?.workspace_host_suffixes ?? [
    ...AGOR_CLOUD.defaultWorkspaceHostSuffixes,
  ];
  return {
    consoleUrl,
    workspaceHostSuffixes: suffixes
      .map((suffix) => suffix.trim().toLowerCase().replace(/^\.+/, ''))
      .filter(Boolean),
  };
}

/** Where the console may send the browser back to (rule shared with the UI). */
export function validateReturnTo(value: string): string {
  const problem = agorCloudReturnToProblem(value);
  if (problem) throw new BadRequest(problem);
  return new URL(value).toString();
}

/** The Cloud workspace origin, accepted only on a configured host suffix. */
export function validateWorkspaceUrl(value: string, suffixes: readonly string[]): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new BadRequest('workspace_url is not a URL');
  }
  const host = url.hostname.toLowerCase();
  if (
    url.protocol !== 'https:' ||
    url.username ||
    url.password ||
    !suffixes.some((suffix) => host === suffix || host.endsWith(`.${suffix}`))
  ) {
    throw new BadRequest('workspace_url is not an Agor Cloud workspace');
  }
  return url.origin;
}

const sha256 = (value: string) => createHash('sha256').update(value).digest();

/** `exp` of a JWT we were handed by the workspace (not verified: it's our own copy). */
function expiresAt(token: string): number {
  try {
    const payload = JSON.parse(Buffer.from(token.split('.')[1] ?? '', 'base64url').toString());
    return typeof payload.exp === 'number' ? payload.exp * 1000 : 0;
  } catch {
    return 0;
  }
}

async function postJson(
  url: string,
  body: unknown,
  timeoutMs: number
): Promise<{ status: number; body: Record<string, unknown> }> {
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify(body),
    redirect: 'error',
    signal: AbortSignal.timeout(timeoutMs),
  });
  const parsed = (await response.json().catch(() => ({}))) as Record<string, unknown>;
  return { status: response.status, body: parsed ?? {} };
}

export class AgorCloudLinkService {
  readonly settings: AgorCloudSettings;

  constructor(private readonly ctx: AgorCloudLinkContext) {
    this.settings = resolveAgorCloudSettings(ctx.config);
  }

  private unit<T>(work: (variables: AppVariableRepository) => Promise<T>): Promise<T> {
    return runWithTenantDatabaseScope(this.ctx.db, this.ctx.tenantId, () =>
      work(new AppVariableRepository(this.ctx.db))
    );
  }

  private async read(): Promise<{ record: LinkRecord; version: string | null }> {
    const { value, version } = await this.unit((variables) =>
      variables.getPlainVersioned(AGOR_CLOUD.linkNamespace, this.ctx.user.user_id)
    );
    try {
      return { record: value ? (JSON.parse(value) as LinkRecord) : {}, version };
    } catch {
      return { record: {}, version };
    }
  }

  /**
   * Read the record, let `change` derive the next one (null: leave it), and
   * write it only if nobody wrote in between; a lost race re-reads and runs
   * `change` again. Returns what was written, or null when `change` declined.
   */
  private async mutate(
    change: (record: LinkRecord) => LinkRecord | null
  ): Promise<LinkRecord | null> {
    for (let attempt = 0; attempt < CAS_ATTEMPTS; attempt++) {
      const { record, version } = await this.read();
      const next = change(record);
      if (!next) return null;
      const empty = !next.pending && !next.completing && !next.link;
      const written = await this.unit((variables) =>
        variables.compareAndSetEncrypted(
          AGOR_CLOUD.linkNamespace,
          this.ctx.user.user_id,
          version,
          empty ? null : JSON.stringify(next),
          this.ctx.user.user_id
        )
      );
      if (written) return next;
    }
    throw new Conflict('Your Agor Cloud connection changed while saving; try again.');
  }

  /** Change the caller's link only while it is still the same sign-in. */
  private updateLink(generation: string, change: (link: StoredLink) => StoredLink | null) {
    return this.mutate((record) => {
      if (!record.link || record.link.generation !== generation) return null;
      const next = change(record.link);
      if (next) record.link = next;
      else delete record.link;
      return record;
    });
  }

  /** The caller's link, after forgetting one idle for too long. */
  private async current(): Promise<StoredLink | null> {
    const { link } = (await this.read()).record;
    if (link && Date.now() - link.last_used_at > AGOR_CLOUD.linkIdleMs) {
      await this.updateLink(link.generation, () => null);
      return null;
    }
    return link ?? null;
  }

  async status(): Promise<AgorCloudLinkStatus> {
    const link = await this.current();
    return {
      console_url: this.settings.consoleUrl,
      link: link
        ? {
            workspace_url: link.workspace_url,
            workspace_display_name: link.workspace_display_name,
            team_slug: link.team_slug,
            cloud_email: link.cloud_email,
            linked_at: link.linked_at,
          }
        : null,
    };
  }

  async start(returnTo: string): Promise<AgorCloudLinkStartResult> {
    const target = validateReturnTo(returnTo);
    const state = randomBytes(32).toString('base64url');
    const expires = Date.now() + AGOR_CLOUD.stateTtlMs;
    // A new sign-in supersedes any one still pending or redeeming.
    await this.mutate((record) => {
      delete record.completing;
      record.pending = {
        state_sha256: sha256(state).toString('hex'),
        return_to: target,
        expires_at: expires,
      };
      return record;
    });
    const url = new URL(`${this.settings.consoleUrl}${AGOR_CLOUD.connectPath}`);
    url.searchParams.set('state', state);
    url.searchParams.set('return_to', target);
    url.searchParams.set('source', new URL(target).host);
    return { authorize_url: url.toString(), expires_at: new Date(expires).toISOString() };
  }

  async complete(input: AgorCloudLinkCompleteRequest): Promise<AgorCloudLinkStatus> {
    // Claim the pending state atomically before anything else: it is spent by
    // the first attempt, whatever happens next, and concurrent attempts lose.
    const claim = randomUUID();
    let pending: PendingSignIn | undefined;
    const claimed = await this.mutate((record) => {
      if (!record.pending) return null;
      pending = record.pending;
      delete record.pending;
      record.completing = claim;
      return record;
    });
    if (!claimed || !pending) {
      throw new BadRequest('This sign-in was already completed or has expired. Sign in again.');
    }
    try {
      return await this.redeem(input, pending, claim);
    } catch (error) {
      await this.mutate((record) => {
        if (record.completing !== claim) return null;
        delete record.completing;
        return record;
      }).catch(() => undefined);
      throw error;
    }
  }

  private async redeem(
    input: AgorCloudLinkCompleteRequest,
    pending: PendingSignIn,
    claim: string
  ): Promise<AgorCloudLinkStatus> {
    const presented = sha256(input.state);
    const expected = Buffer.from(pending.state_sha256, 'hex');
    if (
      expected.length !== presented.length ||
      !timingSafeEqual(expected, presented) ||
      pending.expires_at < Date.now()
    ) {
      throw new BadRequest('This sign-in has expired or was already used. Sign in again.');
    }
    const workspaceUrl = validateWorkspaceUrl(
      input.workspace_url,
      this.settings.workspaceHostSuffixes
    );

    let launched: Awaited<ReturnType<typeof postJson>>;
    try {
      launched = await postJson(
        `${workspaceUrl}/auth/launch`,
        { launch_code: input.launch_code },
        LAUNCH_TIMEOUT_MS
      );
    } catch {
      throw new BadRequest(`Could not reach ${new URL(workspaceUrl).host}. Sign in again.`);
    }
    const { accessToken, refreshToken, user } = launched.body as {
      accessToken?: unknown;
      refreshToken?: unknown;
      user?: { user_id?: unknown; email?: unknown };
    };
    if (launched.status !== 201 && launched.status !== 200) {
      throw new BadRequest(
        'Agor Cloud did not accept this sign-in (it may have expired). Sign in again.'
      );
    }
    if (typeof accessToken !== 'string' || typeof refreshToken !== 'string') {
      throw new BadRequest('Agor Cloud returned an unexpected sign-in response.');
    }
    const now = Date.now();
    const link: StoredLink = {
      generation: randomUUID(),
      workspace_url: workspaceUrl,
      workspace_display_name: input.workspace_display_name?.trim() || null,
      team_slug: input.team_slug?.trim() || null,
      cloud_email: typeof user?.email === 'string' ? user.email : null,
      cloud_user_id: typeof user?.user_id === 'string' ? user.user_id : null,
      linked_at: new Date(now).toISOString(),
      access_token: accessToken,
      refresh_token: refreshToken,
      access_expires_at: expiresAt(accessToken),
      last_used_at: now,
    };
    // Only if this sign-in is still the current one (no Disconnect or newer
    // sign-in meanwhile); otherwise its session is dropped.
    const saved = await this.mutate((record) => {
      if (record.completing !== claim) return null;
      delete record.completing;
      record.link = link;
      return record;
    });
    if (!saved) throw new Conflict('This sign-in was cancelled. Sign in again.');
    return this.status();
  }

  /**
   * A workspace Bearer for the caller's link, refreshed when it is about to
   * expire (or when `force`, after a 401). With `generation`, only for that
   * sign-in: a disconnected or replaced link fails with
   * {@link AGOR_CLOUD_LINK_CHANGED}.
   */
  async session(options: { force?: boolean; generation?: string } = {}): Promise<AgorCloudSession> {
    const link = await this.current();
    if (options.generation !== undefined && link?.generation !== options.generation) {
      throw new Conflict(AGOR_CLOUD_LINK_CHANGED);
    }
    if (!link) throw new NotAuthenticated('Sign in to Agor Cloud first.');
    const host = new URL(link.workspace_url).host;
    let current = link;
    if (options.force || link.access_expires_at - Date.now() < REFRESH_MARGIN_MS) {
      let refreshed: Awaited<ReturnType<typeof postJson>>;
      try {
        refreshed = await postJson(
          `${link.workspace_url}/authentication/refresh`,
          { refreshToken: link.refresh_token },
          LAUNCH_TIMEOUT_MS
        );
      } catch {
        throw new Unavailable(`Agor Cloud (${host}) is unreachable right now. Try again.`);
      }
      const { accessToken, refreshToken, error } = refreshed.body as {
        accessToken?: unknown;
        refreshToken?: unknown;
        error?: unknown;
      };
      if (
        refreshed.status < 200 ||
        refreshed.status >= 300 ||
        typeof accessToken !== 'string' ||
        typeof refreshToken !== 'string'
      ) {
        // Only a definitive rejection ends the Cloud session; anything else
        // (5xx, 429, a malformed answer) keeps it for the next try.
        if (
          refreshed.status === 401 ||
          refreshed.status === 403 ||
          (refreshed.status === 400 && error === 'invalid_grant')
        ) {
          await this.updateLink(link.generation, () => null);
          throw new NotAuthenticated('Your Agor Cloud sign-in expired. Sign in again.');
        }
        throw new Unavailable(`Agor Cloud (${host}) is unreachable right now. Try again.`);
      }
      const saved = await this.updateLink(link.generation, (stored) => ({
        ...stored,
        access_token: accessToken,
        refresh_token: refreshToken,
        access_expires_at: expiresAt(accessToken),
        last_used_at: Date.now(),
      }));
      // Disconnected or replaced while refreshing: drop the new tokens.
      if (!saved?.link) {
        throw options.generation !== undefined
          ? new Conflict(AGOR_CLOUD_LINK_CHANGED)
          : new NotAuthenticated('Sign in to Agor Cloud first.');
      }
      current = saved.link;
    } else if (Date.now() - link.last_used_at > TOUCH_INTERVAL_MS) {
      // Re-sealing costs a key derivation; idle tracking only needs minutes.
      await this.updateLink(link.generation, (stored) => ({ ...stored, last_used_at: Date.now() }));
    }
    return {
      workspaceUrl: current.workspace_url,
      accessToken: current.access_token,
      generation: current.generation,
      cloudUserId: current.cloud_user_id,
    };
  }

  /** Forget the link (and any sign-in in progress) at once. */
  async disconnect(): Promise<AgorCloudLinkStatus> {
    await this.unit((variables) =>
      variables.delete(AGOR_CLOUD.linkNamespace, this.ctx.user.user_id)
    );
    return this.status();
  }
}
