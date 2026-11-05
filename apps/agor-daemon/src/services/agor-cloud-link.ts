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
 * workspace. Disconnect, Done, or 7 days without use forget it.
 */

import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import type { AgorConfig } from '@agor/core/config';
import { AppVariableRepository, runWithTenantDatabaseScope } from '@agor/core/db';
import { BadRequest, NotAuthenticated } from '@agor/core/feathers';
import {
  AGOR_CLOUD,
  type AgorCloudLinkCompleteRequest,
  type AgorCloudLinkPublic,
  type AgorCloudLinkStartResult,
  type AgorCloudLinkStatus,
  type DeepReadonly,
} from '@agor/core/types';
import type { AgorPackServiceContext } from './agor-pack-export.js';

const LAUNCH_TIMEOUT_MS = 10_000;
/** Refresh the workspace access token when less than this is left. */
const REFRESH_MARGIN_MS = 60_000;
const TOUCH_INTERVAL_MS = 5 * 60_000;

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
  cloud_user_id: string | null;
  access_token: string;
  refresh_token: string;
  access_expires_at: number;
  last_used_at: number;
}

interface LinkRecord {
  pending?: PendingSignIn;
  link?: StoredLink;
}

/** A link usable as a workspace Bearer. */
export interface AgorCloudSession {
  workspaceUrl: string;
  accessToken: string;
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

const isLoopback = (hostname: string) =>
  hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '[::1]';

/** Where the console may send the browser back to: https, or http on loopback. */
export function validateReturnTo(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new BadRequest('return_to must be an absolute URL');
  }
  if (
    value.length > AGOR_CLOUD.maxReturnToLength ||
    url.username ||
    url.password ||
    url.hash ||
    !(url.protocol === 'https:' || (url.protocol === 'http:' && isLoopback(url.hostname)))
  ) {
    throw new BadRequest(
      'return_to must be an https URL (or http on localhost) without a fragment'
    );
  }
  return url.toString();
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

  private async read(): Promise<LinkRecord> {
    const raw = await this.unit((variables) =>
      variables.getPlain(AGOR_CLOUD.linkNamespace, this.ctx.user.user_id)
    );
    if (!raw) return {};
    try {
      return JSON.parse(raw) as LinkRecord;
    } catch {
      return {};
    }
  }

  private async write(record: LinkRecord): Promise<void> {
    await this.unit(async (variables) => {
      if (!record.pending && !record.link) {
        await variables.delete(AGOR_CLOUD.linkNamespace, this.ctx.user.user_id);
        return;
      }
      await variables.setEncrypted(
        AGOR_CLOUD.linkNamespace,
        this.ctx.user.user_id,
        JSON.stringify(record),
        this.ctx.user.user_id
      );
    });
  }

  /** The caller's link, after forgetting one idle for too long. */
  private async current(): Promise<LinkRecord> {
    const record = await this.read();
    if (record.link && Date.now() - record.link.last_used_at > AGOR_CLOUD.linkIdleMs) {
      delete record.link;
      await this.write(record);
    }
    return record;
  }

  async status(): Promise<AgorCloudLinkStatus> {
    const { link } = await this.current();
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
    const record = await this.read();
    record.pending = {
      state_sha256: sha256(state).toString('hex'),
      return_to: target,
      expires_at: expires,
    };
    await this.write(record);
    const url = new URL(`${this.settings.consoleUrl}${AGOR_CLOUD.connectPath}`);
    url.searchParams.set('state', state);
    url.searchParams.set('return_to', target);
    url.searchParams.set('source', new URL(target).host);
    return { authorize_url: url.toString(), expires_at: new Date(expires).toISOString() };
  }

  async complete(input: AgorCloudLinkCompleteRequest): Promise<AgorCloudLinkStatus> {
    const record = await this.read();
    const pending = record.pending;
    // Single use: the state is spent by the first attempt, whatever happens next.
    if (pending) {
      delete record.pending;
      await this.write(record);
    }
    const presented = sha256(input.state);
    const expected = pending ? Buffer.from(pending.state_sha256, 'hex') : null;
    if (
      !pending ||
      !expected ||
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
    record.link = {
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
    await this.write(record);
    return this.status();
  }

  /**
   * A workspace Bearer for the caller's link, refreshed when it is about to
   * expire (or when `force` after a 401). Throws when there is no link.
   */
  async session(force = false): Promise<AgorCloudSession> {
    const record = await this.current();
    const link = record.link;
    if (!link) throw new NotAuthenticated('Sign in to Agor Cloud first.');
    const refresh = force || link.access_expires_at - Date.now() < REFRESH_MARGIN_MS;
    if (refresh) {
      let refreshed: Awaited<ReturnType<typeof postJson>>;
      try {
        refreshed = await postJson(
          `${link.workspace_url}/authentication/refresh`,
          { refreshToken: link.refresh_token },
          LAUNCH_TIMEOUT_MS
        );
      } catch {
        throw new BadRequest(`Could not reach ${new URL(link.workspace_url).host}.`);
      }
      const { accessToken, refreshToken } = refreshed.body as {
        accessToken?: unknown;
        refreshToken?: unknown;
      };
      if (typeof accessToken !== 'string' || typeof refreshToken !== 'string') {
        // The Cloud session is gone (expired or revoked): forget it.
        delete record.link;
        await this.write(record);
        throw new NotAuthenticated('Your Agor Cloud sign-in expired. Sign in again.');
      }
      link.access_token = accessToken;
      link.refresh_token = refreshToken;
      link.access_expires_at = expiresAt(accessToken);
    }
    // Re-sealing costs a key derivation; idle tracking only needs minutes.
    if (refresh || Date.now() - link.last_used_at > TOUCH_INTERVAL_MS) {
      link.last_used_at = Date.now();
      await this.write(record);
    }
    return { workspaceUrl: link.workspace_url, accessToken: link.access_token };
  }

  async disconnect(): Promise<AgorCloudLinkStatus> {
    await this.write({});
    return this.status();
  }
}
