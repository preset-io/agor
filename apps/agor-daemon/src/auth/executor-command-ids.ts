/** The only branch-read command that may intentionally omit a Branch claim. */
export const BRANCH_FILESYSTEM_STATUS_EXECUTOR_COMMAND_ID = 'branch-filesystem-status';

/**
 * Canonical identities for taskless executor commands whose bearer also
 * authorizes one raw HTTP data-plane callback.
 *
 * Components are encoded before joining so equality remains unambiguous even
 * if an upstream provider broadens an identifier alphabet later.
 */
function component(value: string): string {
  return encodeURIComponent(value);
}

export function uploadMaterializeExecutorCommandId(sessionId: string, uploadRef: string): string {
  return `upload.materialize:${component(sessionId)}:${component(uploadRef)}`;
}

export function gatewaySlackUploadExecutorCommandId(
  gatewayChannelId: string,
  slackChannelId: string
): string {
  return `gateway.slack-file-upload:${component(gatewayChannelId)}:${component(slackChannelId)}`;
}
