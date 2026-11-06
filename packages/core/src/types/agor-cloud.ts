/**
 * "Sign in to Agor Cloud" from a self-hosted install (Settings → Move to Agor
 * Cloud → Send).
 *
 * The self-hosted UI sends the browser to the Cloud console's connect page;
 * the console signs the user in, lets them pick a workspace, mints an ordinary
 * one-time launch code and redirects back with the code in the URL fragment.
 * The self-hosted daemon redeems it at the workspace's `/auth/launch` and keeps
 * the resulting workspace session sealed server-side; the browser never sees
 * those tokens. The daemon then streams a staged `.agorpack` to the workspace.
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
import { AGOR_PACK, type AgorPackImport, agorPackTeammateKey } from './agor-pack';

export const AGOR_CLOUD = {
  /** Production Cloud console (`agor_cloud.console_url` overrides it). */
  defaultConsoleUrl: 'https://console.agor.cloud',
  /** Workspace hosts the daemon will redeem a launch code at. */
  defaultWorkspaceHostSuffixes: ['agor.cloud', 'cloud.agor.live'],
  connectPath: '/connect/self-hosted',
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

export const agorCloudTransferStartSchema = z
  .object({ export_id: z.string().uuid(), ref: z.string().min(1).max(200) })
  .strict();
export type AgorCloudTransferStartRequest = z.infer<typeof agorCloudTransferStartSchema>;

export const agorCloudTransferApplySchema = z
  .object({ teammates: z.array(agorPackTeammateKey).min(1).max(AGOR_PACK.maxTeammates) })
  .strict();
export type AgorCloudTransferApplyRequest = z.infer<typeof agorCloudTransferApplySchema>;

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

export const AGOR_CLOUD_TRANSFER_STATUSES = [
  'uploading',
  'staged',
  'applying',
  'applied',
  'failed',
] as const;
export type AgorCloudTransferStatus = (typeof AGOR_CLOUD_TRANSFER_STATUSES)[number];

export interface AgorCloudTransfer {
  transfer_id: string;
  status: AgorCloudTransferStatus;
  bytes_sent: number;
  bytes_total: number;
  workspace_url: string;
  /** The workspace's dry-run receipt once staged, then its apply progress. */
  import?: AgorPackImport;
  /** Reconnect checklist in the Cloud workspace, once applied. */
  open_url?: string;
  error?: string;
}

/** The Cloud UI route that opens the reconnect checklist for one import. */
export function agorCloudReconnectUrl(workspaceUrl: string, importId: string): string {
  return `${workspaceUrl.replace(/\/$/, '')}/ui/settings/teammates?import=${encodeURIComponent(importId)}`;
}

/**
 * Hosts a self-hosted Agor may be reached on over plain http and still sign
 * in to Agor Cloud: loopback (localhost, 127.0.0.0/8, ::1), RFC 1918 IPv4
 * (10/8, 172.16/12, 192.168/16), IPv6 ULA (fc00::/7), `.local` / `.internal` /
 * `.lan` names, and single-label names. Never a public host. Takes
 * `URL.hostname` (IPv6 in brackets, IPv4 already normalized by the parser).
 * The Cloud console applies the same rule to `return_to`.
 */
export function isPrivateNetworkHost(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/\.$/, '');
  if (host.startsWith('[') && host.endsWith(']')) {
    const address = host.slice(1, -1);
    if (address === '::1') return true;
    const first = address.split(':')[0] ?? '';
    // fc00::/7: the first 16-bit group is fcxx or fdxx.
    return /^[0-9a-f]{1,4}$/.test(first) && (Number.parseInt(first, 16) & 0xfe00) === 0xfc00;
  }
  const ipv4 = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (ipv4) {
    const [a, b] = [Number(ipv4[1]), Number(ipv4[2])];
    return a === 127 || a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168);
  }
  if (host === 'localhost') return true;
  if (/^[a-z0-9-]+$/.test(host)) return true;
  return /^([a-z0-9-]+\.)+(local|internal|lan)$/.test(host);
}

/**
 * Why a URL can't be the sign-in `return_to`, or null when it can: absolute
 * `https:` anywhere, or `http:` on a {@link isPrivateNetworkHost} host; no
 * userinfo, no fragment, at most {@link AGOR_CLOUD.maxReturnToLength} chars.
 */
export function agorCloudReturnToProblem(value: string): string | null {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return 'return_to must be an absolute URL';
  }
  if (value.length > AGOR_CLOUD.maxReturnToLength) return 'return_to is too long';
  if (url.username || url.password || url.hash) {
    return 'return_to must not carry credentials or a fragment';
  }
  if (url.protocol === 'https:') return null;
  if (url.protocol === 'http:' && isPrivateNetworkHost(url.hostname)) return null;
  return 'Agor must be served over https, or over http on a private network address, to sign in to Agor Cloud';
}
