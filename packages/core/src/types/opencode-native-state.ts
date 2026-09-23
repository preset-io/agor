/**
 * Hosted OpenCode native-state authority. Versions 1/2 are retained only so
 * existing rows can be recognized and failed closed; only v3 is resumable by
 * the coordinated managed-state protocol.
 */
interface OpenCodeNativeStateFields {
  attemptTaskId: string;
  digest: string;
  bytes: number;
  openCodeSessionId: string;
  publishedAt: string;
}

export type LegacyOpenCodeNativeStateAttempt = OpenCodeNativeStateFields &
  ({ version: 1 } | { version: 2; openCodeVersion: string });

export type OpenCodeNativeStateAttempt =
  | LegacyOpenCodeNativeStateAttempt
  | (OpenCodeNativeStateFields & {
      version: 3;
      storeId: string;
      openCodeVersion: string;
    });

export interface OpenCodeCheckpointBinding {
  protocol: 3;
  tenantId: string;
  ownerUserId: string;
  sessionId: string;
  taskId: string;
  storeId: string;
  holderInstanceId: string;
  /** Exact immutable Cloud execution-container identity resolved by the trusted helper. */
  locator: OpenCodeCheckpointLocator;
}

/** Only launch-owned values the executor can snapshot from the Cloud Pod. */
export interface OpenCodeCheckpointLaunchLocator {
  runId: string;
  cellId: string;
  namespace: string;
  podName: string;
  podUid: string;
  containerName: 'executor';
}

export const OPENCODE_CHECKPOINT_CLOUD_ENV = Object.freeze({
  runId: 'AGOR_CLOUD_EXECUTOR_RUN_ID',
  cellId: 'AGOR_CLOUD_EXECUTOR_CELL_ID',
  namespace: 'AGOR_CLOUD_EXECUTOR_NAMESPACE',
  podName: 'AGOR_CLOUD_EXECUTOR_POD_NAME',
  podUid: 'AGOR_CLOUD_EXECUTOR_POD_UID',
  containerName: 'AGOR_CLOUD_EXECUTOR_CONTAINER_NAME',
});

/**
 * Cloud-owned launch coordinates plus the helper-resolved immutable execution
 * identity. A Pod/Job name alone is never authority; the UID/container tuple
 * binds one concrete invocation and does not prove anything beyond the
 * conforming executor's self-registration contract.
 */
export interface OpenCodeCheckpointLocator {
  runId: string;
  cellId: string;
  tenantId: string;
  ownerRuntimeUserId: string;
  sessionId: string;
  taskId: string;
  storeId: string;
  holderInstanceId: string;
  namespace: string;
  jobName: string;
  jobUid: string;
  podName: string;
  podUid: string;
  containerName: 'executor';
  containerId: string;
  restartCount: 0;
  imageIdentity: string;
}

export type OpenCodeCheckpointWriteState = 'open' | 'sealed' | 'abandoned';

export type OpenCodeCleanupLane = 'retire' | 'retry_delete' | 'observe' | 'recheck_absent';

export interface OpenCodeCleanupCursor {
  version: 1;
  nextLane: OpenCodeCleanupLane;
  lanes: Record<OpenCodeCleanupLane, { cursorAttemptNo: number; roundHighWatermark: number }>;
}

export interface OpenCodeCheckpointAttempt {
  tenant_id: string;
  attempt_id: string;
  owner_user_id: string;
  session_id: string;
  task_id: string;
  store_id: string;
  attempt_no: number;
  holder_instance_id: string;
  binding: OpenCodeCheckpointBinding;
  input_store_id: string | null;
  input_task_id: string | null;
  input_read_closed_at: string | null;
  write_state: OpenCodeCheckpointWriteState;
  sealed_manifest: OpenCodeNativeStateAttempt | null;
  retired_at: string | null;
  delete_observed_at: string | null;
  delete_retry_at: string | null;
  delete_failure_count: number;
  delete_last_error: string | null;
  holder_closed_observed_at: string | null;
  holder_observation_retry_at: string | null;
  holder_observation_failure_count: number;
  holder_observation_last_error: string | null;
  created_at: string;
  updated_at: string;
}

export interface OpenCodeCheckpointBeginInput {
  task_id: string;
  holder_instance_id: string;
  locator: OpenCodeCheckpointLaunchLocator;
}

export interface OpenCodeCheckpointHolderInput {
  task_id: string;
  holder_instance_id: string;
}

export interface OpenCodeCheckpointCloseReadInput extends OpenCodeCheckpointHolderInput {
  input: { storeId: string; taskId: string };
}

export interface OpenCodeCheckpointSealInput extends OpenCodeCheckpointHolderInput {
  manifest: OpenCodeNativeStateAttempt;
}

export type OpenCodeCheckpointCleanupWork =
  | { kind: 'delete'; object: { storeId: string; taskId: string } }
  | { kind: 'observe'; attemptId: string }
  | { kind: 'none' };

export type OpenCodeCheckpointDeleteResult =
  | { outcome: 'deleted' }
  | { outcome: 'failed'; errorCode: string };

export type OpenCodeCheckpointAdmission =
  | {
      outcome: 'admitted';
      attempt: OpenCodeCheckpointAttempt;
      input: OpenCodeNativeStateAttempt | null;
    }
  | {
      outcome: 'rejected';
      code: 'legacy_state' | 'already_admitted' | 'task_not_active' | 'invalid_session';
    };

const DIGEST_PATTERN = /^sha256:[0-9a-f]{64}$/;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const VERSION_PATTERN = /^\d+\.\d+\.\d+$/;
const LOCATOR_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/;

export function isOpenCodeCheckpointLaunchLocator(
  value: unknown
): value is OpenCodeCheckpointLaunchLocator {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const candidate = value as Record<string, unknown>;
  return (
    Object.keys(candidate).length === 6 &&
    ['runId', 'cellId', 'namespace', 'podName', 'podUid'].every(
      (key) =>
        typeof candidate[key] === 'string' && LOCATOR_ID_PATTERN.test(candidate[key] as string)
    ) &&
    candidate.containerName === 'executor'
  );
}

export function isOpenCodeNativeStateAttempt(value: unknown): value is OpenCodeNativeStateAttempt {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const candidate = value as Record<string, unknown>;
  const common =
    typeof candidate.attemptTaskId === 'string' &&
    UUID_PATTERN.test(candidate.attemptTaskId) &&
    typeof candidate.digest === 'string' &&
    DIGEST_PATTERN.test(candidate.digest) &&
    typeof candidate.bytes === 'number' &&
    Number.isSafeInteger(candidate.bytes) &&
    candidate.bytes > 0 &&
    typeof candidate.openCodeSessionId === 'string' &&
    candidate.openCodeSessionId.length > 0 &&
    candidate.openCodeSessionId.length <= 200 &&
    typeof candidate.publishedAt === 'string' &&
    !Number.isNaN(Date.parse(candidate.publishedAt));
  if (!common) return false;
  if (candidate.version === 1) return Object.keys(candidate).length === 6;
  if (candidate.version === 2) {
    return (
      Object.keys(candidate).length === 7 &&
      typeof candidate.openCodeVersion === 'string' &&
      VERSION_PATTERN.test(candidate.openCodeVersion)
    );
  }
  return (
    candidate.version === 3 &&
    Object.keys(candidate).length === 8 &&
    typeof candidate.storeId === 'string' &&
    UUID_PATTERN.test(candidate.storeId) &&
    typeof candidate.openCodeVersion === 'string' &&
    VERSION_PATTERN.test(candidate.openCodeVersion)
  );
}

export function isCoordinatedOpenCodeNativeStateAttempt(
  value: unknown
): value is Extract<OpenCodeNativeStateAttempt, { version: 3 }> {
  return isOpenCodeNativeStateAttempt(value) && value.version === 3;
}
