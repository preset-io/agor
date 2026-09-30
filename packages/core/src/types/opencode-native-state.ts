/** Hosted OpenCode checkpoint contracts; see context/explorations/opencode-cloud.md. */

/** Immutable description of one sealed checkpoint file. */
export interface OpenCodeCheckpointManifest {
  version: 1;
  taskId: string;
  digest: string;
  bytes: number;
  openCodeSessionId: string;
  openCodeVersion: string;
}

/** One attempt directory under the owner's home: `sessions/<sessionId>/attempts/<taskId>`. */
export interface OpenCodeCheckpointObject {
  sessionId: string;
  taskId: string;
}

export interface OpenCodeCheckpointBeginInput {
  task_id: string;
  holder_instance_id: string;
}

export type OpenCodeCheckpointAdmission =
  | {
      outcome: 'admitted';
      /** The accepted checkpoint this turn must restore, or null for a new conversation. */
      input: OpenCodeCheckpointManifest | null;
      /** Exact superseded or abandoned attempts of this owner whose files may be removed. */
      cleanup: OpenCodeCheckpointObject[];
      /** The owner's saved key for the Session's hosted provider, or null when none is usable. */
      providerKey?: { providerId: string; key: string } | null;
    }
  /** Another executor already holds this Task; the caller must exit without side effects. */
  | { outcome: 'duplicate' };

/** Transport-only completion field: the sealed checkpoint and the holder that wrote it. */
export interface OpenCodeCheckpointCompletion {
  holder_instance_id: string;
  manifest: OpenCodeCheckpointManifest;
}

export interface OpenCodeCheckpointCleanupInput {
  task_id: string;
  holder_instance_id: string;
  deleted: OpenCodeCheckpointObject[];
}

const DIGEST = /^sha256:[0-9a-f]{64}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const VERSION = /^\d+\.\d+\.\d+$/;

export function isOpenCodeCheckpointManifest(value: unknown): value is OpenCodeCheckpointManifest {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const candidate = value as Record<string, unknown>;
  return (
    Object.keys(candidate).length === 6 &&
    candidate.version === 1 &&
    typeof candidate.taskId === 'string' &&
    UUID.test(candidate.taskId) &&
    typeof candidate.digest === 'string' &&
    DIGEST.test(candidate.digest) &&
    typeof candidate.bytes === 'number' &&
    Number.isSafeInteger(candidate.bytes) &&
    candidate.bytes > 0 &&
    typeof candidate.openCodeSessionId === 'string' &&
    candidate.openCodeSessionId.length > 0 &&
    candidate.openCodeSessionId.length <= 200 &&
    typeof candidate.openCodeVersion === 'string' &&
    VERSION.test(candidate.openCodeVersion)
  );
}
