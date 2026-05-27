export const CLAUDE_SDK_IDLE_TIMEOUT_DEFAULT_MS = 300_000;
export const CLAUDE_SDK_IDLE_TIMEOUT_MIN_MS = 30_000;
export const CLAUDE_SDK_IDLE_TIMEOUT_MAX_MS = 3_600_000;

export const CLAUDE_SDK_IDLE_TIMEOUT_DEFAULT_SECONDS = CLAUDE_SDK_IDLE_TIMEOUT_DEFAULT_MS / 1000;
export const CLAUDE_SDK_IDLE_TIMEOUT_MIN_SECONDS = CLAUDE_SDK_IDLE_TIMEOUT_MIN_MS / 1000;
export const CLAUDE_SDK_IDLE_TIMEOUT_MAX_SECONDS = CLAUDE_SDK_IDLE_TIMEOUT_MAX_MS / 1000;

export function normalizeClaudeSdkIdleTimeoutMs(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return CLAUDE_SDK_IDLE_TIMEOUT_DEFAULT_MS;
  }

  return Math.min(
    CLAUDE_SDK_IDLE_TIMEOUT_MAX_MS,
    Math.max(CLAUDE_SDK_IDLE_TIMEOUT_MIN_MS, Math.trunc(value))
  );
}
