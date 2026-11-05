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
