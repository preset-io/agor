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
export function withRawDetail(message: string, error: unknown): string {
  return `${message} (${errorMessage(error)})`;
}

/** The request may have reached Agor before the connection dropped. */
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
const STALE_REASON = 'It changed since you opened it, so refresh and try again.';

/**
 * Server texts written for agents, the CLI or the API, or full of internals,
 * matched verbatim (wildcards only where the server interpolates). Readable
 * server text is not listed: it shows as is, in brackets. `null` marks a 403
 * that isn't about permission, so no permission reason is guessed.
 */
const REJECTIONS: ReadonlyArray<{ pattern: RegExp; reason: string | null }> = [
  {
    pattern:
      /^Branch working directory is not available \(filesystem_status="[^"]*"\)\. Restore or re-provision the branch before starting a session\.$/,
    reason: "This branch's files aren't available, so restore the branch first.",
  },
  {
    pattern: /^You need '(?!all')[^']+' permission to .+\. You have '[^']+' permission\.$/,
    reason: "Your access to this branch doesn't allow this.",
  },
  {
    pattern: /^You need 'all' (branch )?permission (or admin access )?to .+$/,
    reason: 'You need full control of this branch to do this.',
  },
  {
    pattern: /^No (start|stop|nuke) command configured( for this branch)?$/,
    reason: "Add the command in the branch's Environment settings first.",
  },
  {
    pattern:
      /^Board '.+' not found\. Provide a valid boardId \(use agor_boards_list to see available boards\)\.$/,
    reason: NOT_FOUND_REASON,
  },
  { pattern: /^(Board|Branch) not found: \S+$/, reason: NOT_FOUND_REASON },
  {
    pattern: /^Repository '.+' already exists\.\nUse a different slug with: --slug custom\/name$/,
    reason: 'A repository with that name is already added.',
  },
  {
    pattern:
      /^An active run from schedule ".+" is already in progress and allow_concurrent_runs is disabled\.$/,
    reason: 'A run from this schedule is still in progress.',
  },
  {
    pattern:
      /^Only the artifact's creator or an admin may modify it\. Use agor_artifacts_publish to create your own copy\.$/,
    reason: "Only the artifact's creator or an administrator can change or delete it.",
  },
  {
    pattern: /^This scheduled occurrence is waiting for its durable initialization retry\.$/,
    reason: 'This run is already queued to try again.',
  },
  {
    pattern: /^Knowledge document version mismatch: expected \S+, current is \S+$/,
    reason: STALE_REASON,
  },
  {
    pattern: /^Widget \S+ is already (submitted|dismissed); cannot \w+ again\.$/,
    reason: 'This request was already answered. Refresh to see the result.',
  },
  {
    pattern: /^Widget \S+ is already resolving; cannot \w+ again\.$/,
    reason: 'This request is still being answered. Refresh in a moment to see the result.',
  },
  { pattern: /^Widget \S+ is already \S+; cannot \w+ again\.$/, reason: null },
  { pattern: /^Invalid submit payload: /, reason: null },
  { pattern: /^.+ is disabled for this workspace\.?$/, reason: null },
];

function feathersErrorCode(error: unknown): number | undefined {
  if (!error || typeof error !== 'object') return undefined;
  const { code, name } = error as { code?: unknown; name?: unknown };
  if (code === 403 || name === 'Forbidden') return 403;
  if (code === 404 || name === 'NotFound') return 404;
  return undefined;
}

/** A plain reason for a server rejection, and whether it is only a guess from the status class. */
function describeRejection(error: unknown): { reason: string; guessed: boolean } | null {
  const message = errorMessage(error);
  const match = REJECTIONS.find(({ pattern }) => pattern.test(message));
  if (match) return match.reason === null ? null : { reason: match.reason, guessed: false };
  const code = feathersErrorCode(error);
  if (code === 403) return { reason: PERMISSION_REASON, guessed: true };
  if (code === 404) return { reason: NOT_FOUND_REASON, guessed: true };
  return null;
}

/** Copy for an in-form failure banner: the message, with the raw error under Details. */
export interface ActionErrorCopy {
  message: string;
  raw: string | null;
}

/**
 * The failure copy without the raw error: banners show `raw` under Details;
 * toasts append it in brackets unless `plainReason` (a known server text).
 */
export function describeActionError(
  action: string,
  error: unknown,
  { idempotent }: { idempotent: boolean }
): { message: string; raw: string; plainReason: boolean } {
  const raw = errorMessage(error);
  if (isNotConnectedError(error)) {
    return { message: notConnectedMessage(action), raw, plainReason: false };
  }
  if (isInFlightConnectionLossError(error)) {
    return { message: unconfirmedMessage(action, { idempotent }), raw, plainReason: false };
  }
  const rejection = describeRejection(error);
  if (!rejection) return { message: `Couldn't ${action}.`, raw, plainReason: false };
  return {
    message: `Couldn't ${action}. ${rejection.reason}`,
    raw,
    plainReason: !rejection.guessed,
  };
}

/** Toast copy for a failed action phrase; creates pass `idempotent: false` because a retry after a lost reply can do them twice. */
export function formatActionError(
  action: string,
  error: unknown,
  options: { idempotent: boolean }
): string {
  const { message, raw, plainReason } = describeActionError(action, error, options);
  return plainReason ? message : `${message} (${raw})`;
}

/** A session started, but its first message failed; after a lost reply it may still have landed. */
export function sessionStartedMessageNotSent(error: unknown): string {
  return withRawDetail(
    isInFlightConnectionLossError(error)
      ? 'The session started, but the connection to Agor dropped before your message was confirmed. Open the session to check before you send it again.'
      : "The session started, but your first message wasn't sent. Open the session to send it.",
    error
  );
}

/**
 * A retry after an unconfirmed request whose end state already holds: the
 * server's rejection means the first attempt went through.
 */
export const ALREADY_DONE = {
  boardArchived: /^Board ".+" is already archived$/,
  boardNotArchived: /^Board ".+" is not archived$/,
  boardMissing: /^Board not found: \S+$/,
  branchNotArchived: /^Branch .+ is not archived$/,
} as const;

export function isAlreadyDone(error: unknown, pattern: RegExp): boolean {
  return pattern.test(errorMessage(error));
}
