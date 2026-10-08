/**
 * Durable failure texts written to `task.error_message` that the UI classifies
 * by identity. Producers and the turn outcome banner import them from here, so
 * a rewording cannot silently desynchronize the two.
 */

/**
 * A templated launcher refused the run before creating anything (exit
 * `EXECUTOR_LAUNCH_REFUSED_EXIT_CODE`). Product-neutral, and shown as is by
 * file, git and environment requests, so it avoids "task" and "executor".
 */
export const EXECUTOR_LAUNCH_REFUSED_MESSAGE =
  'Your team has reached its limit of work running at once. Wait for something to finish, then try again.';

export const DAEMON_RESTART_RELEASED_MESSAGE =
  'Daemon restart released this Task without verifying executor termination.';

// Historical export name: this fallback also covers error results after real
// output/tool work. Do not assert the provider returned nothing or imply replay
// is safe; the closed result envelope does not establish either fact.
export const SAFE_ZERO_TURN_PROVIDER_RESULT_MESSAGE =
  'Agor could not confirm a successful response. Review any output and tool activity before retrying.';

/** Wording of `SAFE_ZERO_TURN_PROVIDER_RESULT_MESSAGE` before 2026-09-19 (#2788); older turns keep it. */
export const LEGACY_SAFE_ZERO_TURN_PROVIDER_RESULT_MESSAGE =
  'The provider ended the request without returning a model response. Retry the prompt.';

export const SAFE_MISSING_PROVIDER_RESULT_MESSAGE =
  'The Claude Code stream closed without a final result. Completion could not be confirmed. Review any output and tool activity before retrying.';

export type CodexLifecycleFailureCode =
  | 'authentication_required'
  | 'completed_without_response'
  | 'turn_failed'
  | 'stream_start_failed'
  | 'stream_interrupted'
  | 'stream_ended_without_completion';

export const CODEX_LIFECYCLE_MESSAGES: Readonly<Record<CodexLifecycleFailureCode, string>> = {
  authentication_required:
    'Codex authentication is not configured. Review Codex authentication settings and retry the prompt.',
  completed_without_response:
    'Codex completed after a stream error but returned no assistant response. Retry the prompt.',
  turn_failed:
    'Codex failed the turn. Retry the prompt; review Codex authentication or runtime status if it continues.',
  stream_start_failed: 'Codex could not start the turn. Retry the prompt.',
  stream_interrupted: 'The Codex turn was interrupted before completion. Retry the prompt.',
  stream_ended_without_completion:
    'Codex ended the turn without a completion event. Retry the prompt; restart the session if it continues.',
};

export const CODEX_SUBSCRIPTION_CREDENTIALS_UNAVAILABLE_MESSAGE =
  'Codex subscription credentials are missing or unsafe to mount. Reconnect Codex in Agent Setup or use an API key.';

export const GEMINI_API_KEY_REQUIRED_MESSAGE =
  'Gemini needs an API key. Add one in Settings → Gemini (Google-account sign-in is not supported).';

export function missingScopedCredentialMessage(tool: string): string {
  return `No scoped ${tool} credential is configured for this workspace or user.`;
}

export function missingOpenCodeApiKeyMessage(provider: string): string {
  return `No usable API key for ${provider}. Save one in Settings > OpenCode; hosted workspaces offer API-key providers only.`;
}

function matchesTemplate(text: string, template: (value: string) => string): boolean {
  const [prefix, suffix] = template('\u0000').split('\u0000');
  return (
    text.length > prefix.length + suffix.length && text.startsWith(prefix) && text.endsWith(suffix)
  );
}

/** Separates Agor's fixed failure sentence from an appended closed failure code. */
export const PROVIDER_DETAIL_SEPARATOR = ' Provider detail: ';

/** Agor's fixed sentence first, so classification by identity still works. */
export function withProviderDetail(message: string, detail?: string): string {
  const trimmed = detail?.trim();
  return trimmed ? `${message}${PROVIDER_DETAIL_SEPARATOR}${trimmed}` : message;
}

/** True for any missing-credential failure text an executor writes. */
export function isMissingCredentialMessage(rawText: string): boolean {
  const text = failureMessageBase(rawText);
  return (
    text === GEMINI_API_KEY_REQUIRED_MESSAGE ||
    text === CODEX_SUBSCRIPTION_CREDENTIALS_UNAVAILABLE_MESSAGE ||
    text === CODEX_LIFECYCLE_MESSAGES.authentication_required ||
    matchesTemplate(text, missingScopedCredentialMessage) ||
    matchesTemplate(text, missingOpenCodeApiKeyMessage)
  );
}

/** Prefixes the executor puts on a crash it records as the task error (`packages/executor/src/index.ts`). */
export const EXECUTOR_UNCAUGHT_EXCEPTION_PREFIX = 'uncaughtException: ';
export const EXECUTOR_UNHANDLED_REJECTION_PREFIX = 'unhandledRejection: ';

/**
 * socket.io-client errors (`build/cjs/socket.js`) when the executor's socket to
 * the Agor daemon drops mid-run: a pending ack rejected because the socket
 * disconnected, or an ack that timed out. Neither is a run limit.
 */
export const CONNECTION_LOSS_TEXTS = [
  'socket has been disconnected',
  'operation has timed out',
] as const;

const CRASH_PREFIX = new RegExp(
  `^(?:${EXECUTOR_UNCAUGHT_EXCEPTION_PREFIX}|${EXECUTOR_UNHANDLED_REJECTION_PREFIX})`
);

/** The fixed failure sentence of a stored error, without a crash prefix or appended detail. */
export function failureMessageBase(text: string): string {
  const trimmed = text.trim().replace(CRASH_PREFIX, '');
  const at = trimmed.indexOf(PROVIDER_DETAIL_SEPARATOR);
  return at === -1 ? trimmed : trimmed.slice(0, at);
}

const ERROR_PREFIX = new RegExp(
  `^(?:${EXECUTOR_UNCAUGHT_EXCEPTION_PREFIX}|${EXECUTOR_UNHANDLED_REJECTION_PREFIX}|Error: )`
);

/** Exact library text, tolerating the executor crash prefix and a leading `Error: `. */
export function isConnectionLossMessage(text: string): boolean {
  let message = text.trim();
  for (let previous = ''; previous !== message; ) {
    previous = message;
    message = message.replace(ERROR_PREFIX, '');
  }
  return (CONNECTION_LOSS_TEXTS as readonly string[]).includes(message);
}

export function permissionTimeoutMessage(timeoutMs: number): string {
  return `Permission request timed out after ${timeoutMs}ms.`;
}

/** The configured approval timeout recorded in a permission-timeout failure text. */
export function parsePermissionTimeoutMs(text: string): number | undefined {
  const [prefix, suffix] = permissionTimeoutMessage(0).split('0');
  const value = text.trim();
  if (!value.startsWith(prefix) || !value.endsWith(suffix)) return undefined;
  const ms = Number(value.slice(prefix.length, value.length - suffix.length));
  return Number.isInteger(ms) && ms > 0 ? ms : undefined;
}
