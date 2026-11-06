/**
 * "Sign in to Agor Cloud" from a self-hosted install (Settings → Agor Cloud →
 * Move to Agor Cloud).
 *
 * The self-hosted UI sends the browser to the Cloud console's connect page;
 * the console signs the user in, lets them pick a workspace, mints an ordinary
 * one-time launch code and redirects back with the code in the URL fragment.
 * The self-hosted daemon redeems it at the workspace's `/auth/launch` and keeps
 * the resulting workspace session sealed server-side; the browser never sees
 * those tokens. The daemon then sends `.agor` files to the workspace.
 *
 * Contract with the console page:
 *
 *   GET <console_url>/connect/self-hosted?state=…&return_to=…&source=…
 *   → <return_to>#state=…&launch_code=…&workspace_url=…
 *                 [&workspace_display_name=…&team_slug=…]
 *
 * The console mints the code with `purpose: 'self_hosted_import'`.
 */

import { z } from 'zod';

export const AGOR_CLOUD = {
  /** Production Cloud console (`agor_cloud.console_url` overrides it). */
  defaultConsoleUrl: 'https://console.agor.cloud',
  /** Workspace hosts the daemon will redeem a launch code at. */
  defaultWorkspaceHostSuffixes: ['agor.cloud', 'cloud.agor.live'],
  connectPath: '/connect/self-hosted',
  /**
   * The console's launch-init (direct entry): it signs the browser in, mints a
   * launch code for the workspace at `return_host`, and lands on the
   * site-relative `return_to` there.
   */
  launchInitPath: '/api/launch-codes/init',
  /** Launch-code purpose the console records in the team audit log. */
  launchPurpose: 'self_hosted_import',
  /** `app_variables` namespace of the sealed per-user link (key: user id). */
  linkNamespace: 'agor_cloud_link',
  /** Sign-in round trip lifetime (start → complete). */
  stateTtlMs: 10 * 60 * 1000,
  /** A link nobody used for this long is forgotten. */
  linkIdleMs: 7 * 24 * 60 * 60 * 1000,
  maxReturnToLength: 2048,
} as const;

/** Fields the console puts in the return URL fragment. */
export const AGOR_CLOUD_RETURN_FIELDS = [
  'state',
  'launch_code',
  'workspace_url',
  'workspace_display_name',
  'team_slug',
] as const;

export const agorCloudLinkStartSchema = z
  .object({ return_to: z.string().min(1).max(AGOR_CLOUD.maxReturnToLength) })
  .strict();
export type AgorCloudLinkStartRequest = z.infer<typeof agorCloudLinkStartSchema>;

export const agorCloudLinkCompleteSchema = z
  .object({
    state: z.string().min(1).max(256),
    launch_code: z.string().min(1).max(4096),
    workspace_url: z.string().min(1).max(2048),
    workspace_display_name: z.string().max(200).optional(),
    team_slug: z.string().max(200).optional(),
  })
  .strict();
export type AgorCloudLinkCompleteRequest = z.infer<typeof agorCloudLinkCompleteSchema>;

/** Retry one teammate of a move that failed. */
export const agorCloudMoveRetrySchema = z.object({ branch_id: z.string().uuid() }).strict();
export type AgorCloudMoveRetryRequest = z.infer<typeof agorCloudMoveRetrySchema>;

export interface AgorCloudLinkPublic {
  workspace_url: string;
  workspace_display_name: string | null;
  team_slug: string | null;
  cloud_email: string | null;
  linked_at: string;
}

/** `GET /agor-pack/cloud/link`. Never carries tokens. */
export interface AgorCloudLinkStatus {
  console_url: string;
  link: AgorCloudLinkPublic | null;
}

export interface AgorCloudLinkStartResult {
  authorize_url: string;
  expires_at: string;
}

/**
 * One teammate of a move: exported here, sent to the workspace with the
 * resumable chunked upload, then imported there (a new board).
 */
export const AGOR_CLOUD_MOVE_ITEM_STATUSES = [
  'waiting',
  'exporting',
  'sending',
  'importing',
  'done',
  'failed',
] as const;
export type AgorCloudMoveItemStatus = (typeof AGOR_CLOUD_MOVE_ITEM_STATUSES)[number];

export interface AgorCloudMoveItem {
  branch_id: string;
  display_name: string;
  emoji: string | null;
  status: AgorCloudMoveItemStatus;
  /** Bytes of the `.agor` file sent so far (0 until it is exported). */
  bytes_sent: number;
  bytes_total: number;
  /** The workspace's import, once the file is there. */
  import_id?: string;
  /** Finish setup for this teammate in the workspace, once imported. */
  open_url?: string;
  error?: string;
}

/**
 * `POST /agor-pack/cloud/moves`: teammates move one after another on the
 * daemon, so the browser can close. `moving` until every item is done or
 * failed.
 */
export interface AgorCloudMove {
  move_id: string;
  status: 'moving' | 'finished';
  workspace_url: string;
  workspace_display_name: string | null;
  created_at: string;
  items: AgorCloudMoveItem[];
}

/** The workspace UI route that opens Finish setup for one import (Settings → Import). */
export function agorPackImportPath(importId: string): string {
  return `/ui/settings/import?import=${encodeURIComponent(importId)}`;
}

/**
 * A page of an Agor Cloud workspace, entered through the console's
 * launch-init so a browser that isn't signed in to the workspace signs in
 * first and still lands on `path` (site-relative).
 */
export function agorCloudWorkspacePageUrl(
  consoleUrl: string,
  workspaceUrl: string,
  path: string
): string {
  const url = new URL(`${consoleUrl.replace(/\/+$/, '')}${AGOR_CLOUD.launchInitPath}`);
  url.searchParams.set('return_host', new URL(workspaceUrl).host);
  url.searchParams.set('return_to', path);
  return url.toString();
}

/** Finish setup for an import in an Agor Cloud workspace (see {@link agorCloudWorkspacePageUrl}). */
export function agorCloudFinishSetupUrl(
  consoleUrl: string,
  workspaceUrl: string,
  importId: string
): string {
  return agorCloudWorkspacePageUrl(consoleUrl, workspaceUrl, agorPackImportPath(importId));
}

const HOSTNAME_PATTERN =
  /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*$/;
const IPV4_PATTERN = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;
const PRIVATE_NAME_SUFFIXES = ['.local', '.internal', '.lan'];

/**
 * Whether a WHATWG-normalized `URL.hostname` names a private-network host, the
 * only hosts a self-hosted Agor may be reached on over plain `http:` and still
 * sign in to Agor Cloud. Identical rule in the Cloud console
 * (preset-io/agor-cloud `packages/contracts/src/self-hosted-connect.ts`):
 * - `localhost`, 127.0.0.0/8, `[::1]`;
 * - RFC 1918 IPv4: 10.0.0.0/8, 172.16.0.0/12, 192.168.0.0/16;
 * - IPv6 unique-local fc00::/7;
 * - a name ending in `.local`, `.internal` or `.lan`, or a single-label name (no dot).
 * The URL parser has already lowercased the host and canonicalized IPv4
 * (`10.1` → `10.0.0.1`, an all-digit label → IPv4) and IPv6. Trailing-dot
 * names and IPv4-mapped IPv6 do not match.
 */
export function isPrivateNetworkHost(hostname: string): boolean {
  if (hostname.startsWith('[')) {
    return hostname === '[::1]' || /^\[f[cd][0-9a-f]{2}:/.test(hostname);
  }
  const ipv4 = IPV4_PATTERN.exec(hostname);
  if (ipv4) {
    const [a, b] = [Number(ipv4[1]), Number(ipv4[2])];
    return a === 127 || a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168);
  }
  if (!HOSTNAME_PATTERN.test(hostname)) return false;
  return (
    !hostname.includes('.') || PRIVATE_NAME_SUFFIXES.some((suffix) => hostname.endsWith(suffix))
  );
}

/**
 * Why a URL can't be the sign-in `return_to`, or null when it can (same rule
 * as the console's `parseSelfHostedReturnTo`): absolute `https:` on any valid
 * host, or `http:` only on a {@link isPrivateNetworkHost} host; no userinfo,
 * no `#`, at most {@link AGOR_CLOUD.maxReturnToLength} chars.
 */
export function agorCloudReturnToProblem(value: string): string | null {
  if (value.length > AGOR_CLOUD.maxReturnToLength) return 'return_to is too long';
  if (value.includes('#')) return 'return_to must not carry a fragment';
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return 'return_to must be an absolute URL';
  }
  if (url.username || url.password) return 'return_to must not carry credentials';
  const host = url.hostname;
  const validHost = host.startsWith('[') || (host.length <= 253 && HOSTNAME_PATTERN.test(host));
  if (!validHost) return 'return_to has an invalid host';
  if (url.protocol === 'https:') return null;
  if (url.protocol === 'http:' && isPrivateNetworkHost(host)) return null;
  return 'Agor must be served over https, or over http on a private network address, to sign in to Agor Cloud';
}
