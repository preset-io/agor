/**
 * Hosted OpenCode native-state checkpoint pointer.
 *
 * In `managed-projection` deployments the OpenCode executor keeps the live
 * SQLite database on Job-local scratch and, after a successful turn, publishes
 * one immutable, integrity-verified copy under the session owner's persistent
 * executor home (`.../sessions/<agorSessionId>/attempts/<taskId>/`). This
 * pointer names the accepted copy. It is written only by the task terminal
 * transition (Session lock first, then Task lock) together with
 * `status = completed`, so a stale or late executor can never make its own
 * artifact current. See `context/explorations/opencode-cloud.md` §5.
 */
export interface OpenCodeNativeStateAttempt {
  version: 1;
  /** Task whose executor wrote the artifact; equals the attempt directory name. */
  attemptTaskId: string;
  /** `sha256:<hex>` of the checkpointed `opencode.db` file. */
  digest: string;
  /** Size of the checkpointed database in bytes. */
  bytes: number;
  /** Native OpenCode session id that the checkpoint continues. */
  openCodeSessionId: string;
  /** ISO timestamp recorded by the executor after the durability barrier. */
  publishedAt: string;
}

const DIGEST_PATTERN = /^sha256:[0-9a-f]{64}$/;
const TASK_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Strict shape check for executor-supplied pointers; anything else fails closed. */
export function isOpenCodeNativeStateAttempt(value: unknown): value is OpenCodeNativeStateAttempt {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const candidate = value as Record<string, unknown>;
  return (
    candidate.version === 1 &&
    typeof candidate.attemptTaskId === 'string' &&
    TASK_ID_PATTERN.test(candidate.attemptTaskId) &&
    typeof candidate.digest === 'string' &&
    DIGEST_PATTERN.test(candidate.digest) &&
    typeof candidate.bytes === 'number' &&
    Number.isInteger(candidate.bytes) &&
    candidate.bytes > 0 &&
    typeof candidate.openCodeSessionId === 'string' &&
    candidate.openCodeSessionId.length > 0 &&
    candidate.openCodeSessionId.length <= 200 &&
    typeof candidate.publishedAt === 'string' &&
    !Number.isNaN(Date.parse(candidate.publishedAt)) &&
    Object.keys(candidate).length === 6
  );
}
