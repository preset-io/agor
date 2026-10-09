/** socket.io-client rejects an acknowledgement it already sent with these, so the server may have acted. */
export const SOCKET_DISCONNECTED_ERROR = 'socket has been disconnected';
export const SOCKET_ACK_TIMEOUT_ERROR = 'operation has timed out';

/** Thrown by the UI itself before any request when an action starts without a live client. */
export const CLIENT_NOT_CONNECTED_ERROR = 'Client not connected';

const IN_FLIGHT_CONNECTION_LOSS_MESSAGES: ReadonlySet<string> = new Set([
  SOCKET_DISCONNECTED_ERROR,
  SOCKET_ACK_TIMEOUT_ERROR,
]);

export function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === 'string') return error;
  if (error && typeof error === 'object' && typeof (error as Error).message === 'string') {
    return (error as Error).message;
  }
  return String(error);
}

/** The request may have reached Agor before the connection dropped, so its outcome is unknown. */
export function isInFlightConnectionLossError(error: unknown): boolean {
  return IN_FLIGHT_CONNECTION_LOSS_MESSAGES.has(errorMessage(error));
}

/** The action failed because there was no connection, so nothing was sent. */
function isNotConnectedError(error: unknown): boolean {
  return errorMessage(error) === CLIENT_NOT_CONNECTED_ERROR;
}

/** Appends the raw error in brackets so technical readers (and Copy) still see it. */
export function withConnectionErrorDetail(message: string, error: unknown): string {
  return `${message} (${errorMessage(error)})`;
}

/** The request may have reached Agor before the connection dropped (#2992 wording). */
export function unconfirmedMessage(
  action: string,
  { idempotent }: { idempotent: boolean }
): string {
  return idempotent
    ? `The connection to Agor dropped before this was confirmed. If it didn't go through, try to ${action} again once the connection is back.`
    : `The connection to Agor dropped before this was confirmed. Refresh to see if it went through before you try to ${action} again.`;
}

/** Tooltip for a control disabled while the connection is down. */
export const LOST_CONNECTION_TOOLTIP = 'Lost connection to Agor.';

/** Copy for a UI guard that finds no client before sending; nothing was thrown, so no brackets. */
export function notConnectedMessage(action: string): string {
  return `Couldn't ${action}. The connection to Agor dropped. Try again once it's back.`;
}

const PERMISSION_REASON = "You don't have permission to do this.";
const NOT_FOUND_REASON = 'It may have been deleted, or you may not have access.';
const BRANCH_CONTROL_REASONS: Record<string, string> = {
  'update the branch': 'You need full control of this branch to change it.',
  'start the scheduled run': 'You need full control of this branch to run schedules.',
  'start the environment': 'You need full control of this branch to control its environment.',
  'stop the environment': 'You need full control of this branch to control its environment.',
  'nuke the environment': 'You need full control of this branch to control its environment.',
};

/** `null`: a known text with no plain reason; show the raw text, not the status-class guess. */
type Reason = string | null | ((action: string) => string | null);

/**
 * Server text written for the CLI, API or agents, matched verbatim (anchored;
 * wildcards only where the server interpolates). `passThrough` texts are
 * already plain and replace the reason and the raw text.
 */
const REJECTIONS: ReadonlyArray<{ pattern: RegExp; reason: Reason; passThrough?: true }> = [
  // Sessions
  {
    pattern: /^Cannot delete session \S+ while it has unfinished tasks\. Stop them first\.$/,
    reason: "It's still running, so stop it first.",
  },
  {
    pattern: /^This branch does not allow shared session prompting\.$/,
    reason: "This branch doesn't allow others to start sessions here.",
  },
  {
    pattern:
      /^Branch working directory is not available \(filesystem_status="(cleaned|preserved|deleted)"\)\. Restore or re-provision the branch before starting a session\.$/,
    reason: "This branch's files were removed, so restore them first.",
  },
  {
    pattern: /^You need '(?!all')[^']+' permission to .+\. You have '[^']+' permission\.$/,
    reason: (action) =>
      action === 'start the session'
        ? "You don't have permission to start sessions on this branch."
        : PERMISSION_REASON,
  },
  {
    pattern: /^You need 'all' (branch )?permission (or admin access )?to .+$/,
    reason: (action) =>
      BRANCH_CONTROL_REASONS[action] ?? 'You need full control of this branch to do this.',
  },
  // Branches
  {
    pattern: /^A branch named '.+' already exists in this repository$/,
    reason: 'A branch with that name already exists, so choose another name.',
  },
  {
    pattern:
      /^An archived branch named '.+' still owns this workspace path\. Unarchive it instead of creating a new branch\.$/,
    reason: 'An archived branch already uses this name, so unarchive it instead.',
  },
  {
    pattern:
      /^Board '.+' not found\. Provide a valid boardId \(use agor_boards_list to see available boards\)\.$/,
    reason: 'That board no longer exists.',
  },
  {
    pattern: /^Board Editor or Manager access is required to (attach|detach) (a|this) branch$/,
    reason: 'You need edit access to this board.',
  },
  // Boards
  { pattern: /^Board not found: \S+$/, reason: NOT_FOUND_REASON },
  {
    pattern: /^You need Board Editor or Manager access to .+$/,
    reason: 'You need edit access to this board.',
  },
  {
    pattern: /^Zone ".*" has no trigger template configured$/,
    reason: 'Add a prompt template in zone settings first.',
  },
  {
    pattern: /^Zone ".*" trigger rendered to an empty prompt; not creating session$/,
    reason: 'Its prompt template came out empty, so check it in zone settings.',
  },
  {
    pattern: /^You need member access to create boards$/,
    reason: 'Only members and administrators can create boards.',
  },
  // Repositories
  {
    pattern: /^Repository '.+' already exists\.\nUse a different slug with: --slug custom\/name$/,
    reason: 'A repository with that name is already added.',
  },
  { pattern: /^Path must be absolute: /, reason: 'Use the full path, starting with /.' },
  { pattern: /^Not a valid git repository: /, reason: "That folder isn't a Git repository." },
  {
    pattern: /^Local repository registration is unavailable in hosted multi-tenant mode\.$/,
    reason: "Local repositories aren't available here.",
  },
  {
    pattern: /^A repository with slug '.+' already exists$/,
    reason: 'Another repository already uses that name.',
  },
  {
    pattern:
      /^Permanently delete this repository’s branches first and wait for completion before removing the repository\.$/,
    reason: 'Delete its branches first, then try again.',
  },
  {
    pattern: /^SAFETY CHECK FAILED: /,
    reason: 'Agor stopped early to protect your files, so please report this.',
  },
  // Schedules
  {
    pattern:
      /^Branch ".+" has no schedules\. Create one and call POST \/schedules\/:id\/run-now instead\.$/,
    reason: 'This branch has no schedules yet, so create one first.',
  },
  {
    pattern:
      /^Branch ".+" has \d+ schedules\. This route is back-compat only for the single-schedule case\. Pick one and call POST \/schedules\/:id\/run-now\.$/,
    reason: 'This branch has several schedules, so run one from the Schedules tab.',
  },
  {
    pattern:
      /^An active run from schedule ".+" is already in progress and allow_concurrent_runs is disabled\.$/,
    reason: 'A run from this schedule is still in progress.',
  },
  {
    pattern: /^Schedule creator \S+ no longer has Collaborator access to branch \S+$/,
    reason: "The schedule's creator no longer has access to this branch.",
  },
  {
    pattern: /^Scheduler service is not enabled on this instance\.$/,
    reason: 'Schedules are turned off for this workspace.',
  },
  // Environments
  {
    pattern: /^No start command configured for this branch$/,
    reason: "Add a start command in the branch's Environment settings first.",
  },
  {
    pattern: /^An environment command is still active; wait for its result or deadline$/,
    reason: 'The last environment command is still running, so wait for it to finish.',
  },
  {
    pattern: /^Environment is already running or waiting for health; Stop it first$/,
    reason: "It's already running, so stop it first.",
  },
  {
    pattern:
      /^Previous environment cleanup is unconfirmed\. Refresh and explicitly confirm Start anyway for the current attempt\.$/,
    reason: "Agor couldn't confirm the last cleanup, so refresh and choose Start anyway.",
  },
  {
    pattern: /^Environment configuration changed; refresh before retrying$/,
    reason: 'Its settings changed, so refresh and try again.',
  },
  {
    pattern: /^Environment commands require a ready, non-archived branch$/,
    reason: 'The branch must be set up and not archived.',
  },
  // MCP servers
  {
    pattern:
      /^Only admins can configure stdio MCP servers; members can configure remote \(http\/sse\) servers$/,
    reason:
      'Only administrators can add servers that run a command, but members can add servers by URL.',
  },
  // Artifacts
  {
    pattern:
      /^Only the artifact's creator or an admin may modify it\. Use agor_artifacts_publish to create your own copy\.$/,
    reason: (action) =>
      action.startsWith('delete')
        ? "Only the artifact's creator or an administrator can delete it."
        : "Only the artifact's creator or an administrator can change it.",
  },
  // Gateway channels
  {
    pattern: /^You need admin access to (create|update|delete) gateway channels$/,
    reason: (action) =>
      action.startsWith('create')
        ? 'Only administrators can create channels.'
        : 'Only administrators can change channels.',
  },
  // Comments
  {
    pattern: /^You need member access to (create|update) board comments$/,
    reason: 'Only members and administrators can comment.',
  },
  {
    pattern: /^Only the comment author may .+$/,
    reason: "Only the comment's author or an administrator can do this.",
  },
  // MCP marketplace
  {
    pattern:
      /^Session attachments changed\. Review the current count and confirm deletion again\.$/,
    reason: 'The sessions using it changed, so check the count and confirm again.',
  },
  // MCP sign-in widget
  {
    pattern: /^MCP OAuth status is unavailable on this daemon; try Connect again\.$/,
    reason: "Agor couldn't check the sign-in status, so try Connect again.",
  },
  {
    pattern: /^Only admins can connect a shared MCP OAuth server$/,
    reason: 'Only administrators can connect a shared MCP server.',
  },
  {
    pattern:
      /^Sign-in to ".+" has not completed\. Finish the provider sign-in, then try Connect again\.$/,
    reason: "Sign-in hasn't finished, so finish it in the provider window and try Connect again.",
  },
  {
    pattern:
      /^Agor is still finishing the connection to ".+"\. Wait a moment, then press Connect again — you should not need to sign in again\.$/,
    reason: 'Agor is still finishing the connection, so wait a moment and try Connect again.',
  },
  {
    pattern: /^That MCP server is not available to you$/,
    reason: "This MCP server isn't available to you.",
  },
  {
    pattern: /^".+" is no longer an enabled OAuth MCP server; reconfigure it and ask again\.$/,
    reason:
      "This MCP server is no longer set up for sign-in, so ask the agent again after it's fixed.",
  },
  {
    pattern: /^".+" changed OAuth mode since this request was made; ask again\.$/,
    reason: "This MCP server's sign-in settings changed, so ask the agent again.",
  },
  // Widgets
  {
    pattern: /^Widget \S+ is already \w+; cannot \w+ again\.$/,
    reason: 'It was already answered, so refresh to see the result.',
  },
  { pattern: /^Invalid submit payload: /, reason: null },
  // Gateway channels (token widget)
  {
    pattern: /^Only admins can set gateway channel tokens$/,
    reason: 'Only administrators can set channel tokens.',
  },
  {
    pattern:
      /^(Gateway channel \S+ not found|Gateway channel type does not match the widget request|Gateway channel is not bound to this session's branch)$/,
    reason:
      'This request no longer matches the channel, so ask the agent to request the tokens again.',
  },
  // GitHub App install
  {
    pattern: /^Admin role required to initiate GitHub App install$/,
    reason: 'Only administrators can install the GitHub App.',
  },
  {
    pattern: /^Authentication required to initiate GitHub App install$/,
    reason: 'Sign in again first.',
  },
  {
    pattern: /^GitHub App install setup is temporarily unavailable$/,
    reason: "Agor can't start installs right now, so try again later.",
  },
  // Schedules
  {
    pattern:
      /^MCP server \S+ is private to another user\. Schedules run as their creator, so only shared servers or servers the creator owns can be attached\.$/,
    reason: "It uses another user's private MCP server, so choose a shared one.",
  },
  {
    pattern: /^This scheduled occurrence is waiting for its durable initialization retry\.$/,
    reason: 'This run is already queued to try again.',
  },
  // Knowledge
  {
    pattern: /^Knowledge document archive state changed; reload before retrying$/,
    reason: 'It changed since you opened it, so refresh and try again.',
  },
  {
    pattern: /^Knowledge document version mismatch: expected \S+, current is \S+$/,
    reason: 'It changed since you opened it, so refresh and try again.',
  },
  // Uploads (an optional support reference follows each policy text)
  {
    pattern: /^Unsupported file type( \(reference: [^)]+\))?$/,
    reason: "Agor doesn't accept this file type.",
  },
  {
    pattern: /^A file exceeds the upload size limit( \(reference: [^)]+\))?$/,
    reason: 'A file is over the size limit.',
  },
  {
    pattern: /^Combined upload size exceeds the upload size limit( \(reference: [^)]+\))?$/,
    reason: 'The files together are over the size limit.',
  },
  {
    pattern: /^Too many files( \(reference: [^)]+\))?$/,
    reason: 'Too many files at once.',
  },
  {
    pattern: /^Upload too large( \(reference: [^)]+\))?$/,
    reason: 'The upload is over the size limit.',
  },
  // Users
  {
    pattern:
      /^This user still owns boards or branches\. Delete those resources before deleting the user\.$/,
    reason: 'They still own boards or branches, so delete those first.',
  },
  {
    pattern: /^User with email .+ already exists$/,
    reason: 'A user with that email already exists.',
  },
  // Already plain (glossary pass-through list)
  ...[
    'Saved onboarding progress is no longer available. Reopen Settings.',
    'Schedule is disabled. Enable it before running manually.',
    'Schedules run as the user who created them. You can only manually run schedules you created.',
    'That MCP server was not found. Remove the unavailable selection from MCP Servers and try again.',
    "This session uses its owner's execution home and cannot be shared. Start a separate session you own, or start a new branch-home session on this branch.",
    'Session sharing is disabled for this workspace. Start a separate session you own.',
    'This branch does not allow shared session prompting. Ask a Branch Manager to enable it, or start a separate session you own.',
    "You don't have permission to prompt this branch. Only Collaborators and Managers can prompt sessions on it.",
  ].map((text) => ({
    pattern: new RegExp(`^${escapeRegExp(text)}$`),
    reason: text,
    passThrough: true as const,
  })),
];

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function feathersErrorCode(error: unknown): number | undefined {
  if (!error || typeof error !== 'object') return undefined;
  const { code, name } = error as { code?: unknown; name?: unknown };
  if (code === 403 || name === 'Forbidden') return 403;
  if (code === 404 || name === 'NotFound') return 404;
  return undefined;
}

/** A plain reason for a server rejection, or null when none is known. */
export function describeRejection(
  action: string,
  error: unknown
): { reason: string; passThrough: boolean } | null {
  const message = errorMessage(error);
  const match = REJECTIONS.find(({ pattern }) => pattern.test(message));
  if (match) {
    if (match.reason === null) return null;
    const reason = typeof match.reason === 'function' ? match.reason(action) : match.reason;
    if (reason) return { reason, passThrough: !!match.passThrough };
  }
  const code = feathersErrorCode(error);
  if (code === 403) return { reason: PERMISSION_REASON, passThrough: false };
  if (code === 404) return { reason: NOT_FOUND_REASON, passThrough: false };
  return null;
}

/**
 * The failure copy without the raw error: banners show `raw` under Details;
 * toasts append it in brackets only when there is no plain reason (see
 * `formatActionError`). `raw` is null for a pass-through server text.
 */
export function describeActionError(
  action: string,
  error: unknown,
  { idempotent }: { idempotent: boolean }
): { message: string; raw: string | null; plainReason?: boolean } {
  const raw = errorMessage(error);
  if (isNotConnectedError(error)) {
    return { message: notConnectedMessage(action), raw, plainReason: false };
  }
  if (isInFlightConnectionLossError(error)) {
    return {
      message: unconfirmedMessage(action, { idempotent }),
      raw,
      plainReason: false,
    };
  }
  const rejection = describeRejection(action, error);
  if (!rejection) return { message: `Couldn't ${action}.`, raw, plainReason: false };
  return {
    message: `Couldn't ${action}. ${rejection.reason}`,
    raw: rejection.passThrough ? null : raw,
    plainReason: true,
  };
}

/** Toast copy for a failed action phrase; creates pass `idempotent: false` because a retry after a lost reply can do them twice. */
export function formatActionError(
  action: string,
  error: unknown,
  options: { idempotent: boolean }
): string {
  const { message, raw, plainReason } = describeActionError(action, error, options);
  // A plain reason replaces the raw text; #2992's connection copy keeps its bracket.
  return raw === null || plainReason ? message : `${message} (${raw})`;
}

/** A session started, but its first message failed; after a lost reply it may still have landed. */
export function sessionStartedMessageNotSent(error: unknown): string {
  return withConnectionErrorDetail(
    isInFlightConnectionLossError(error)
      ? 'The session started, but the connection to Agor dropped before your message was confirmed. Open the session to check before you send it again.'
      : "The session started, but your first message wasn't sent. Open the session to send it.",
    error
  );
}

/**
 * Replays of an idempotent action whose end state already holds. The #2992
 * copy invites a retry after an unconfirmed request, so the retry's rejection
 * means the first attempt went through.
 */
const ALREADY_DONE: ReadonlyArray<{ action: string; pattern: RegExp }> = [
  { action: 'archive the board', pattern: /^Board ".+" is already archived$/ },
  { action: 'unarchive the board', pattern: /^Board ".+" is not archived$/ },
  { action: 'delete the board', pattern: /^Board not found: \S+$/ },
  { action: 'unarchive the branch', pattern: /^Branch .+ is not archived$/ },
];

/** The rejection says `action` already happened, so the caller shows its success copy. */
export function isAlreadyDoneError(action: string, error: unknown): boolean {
  const message = errorMessage(error);
  return ALREADY_DONE.some((entry) => entry.action === action && entry.pattern.test(message));
}
