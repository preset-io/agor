/** Wire shape returned only after the daemon commits the managed Task holder. */
import { OPENCODE_OBSERVER_BUSY_REASON } from '@agor/core/types';

const OBSERVER_BUSY_DELAYS_MS = [150, 300, 600, 1_200, 2_400] as const;
const TRANSPORT_DELAYS_MS = [200, 500, 1_000, 1_500, 2_000] as const;

function isObserverBusy(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  const candidate = error as { code?: unknown; data?: { reason?: unknown } };
  return candidate.code === 429 && candidate.data?.reason === OPENCODE_OBSERVER_BUSY_REASON;
}

export function isRetryableTransportFailure(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  const candidate = error as { code?: unknown };
  return (
    candidate.code === 408 ||
    candidate.code === 502 ||
    candidate.code === 503 ||
    candidate.code === 504 ||
    candidate.code === 'ECONNRESET' ||
    candidate.code === 'ECONNREFUSED' ||
    candidate.code === 'EPIPE' ||
    candidate.code === 'ETIMEDOUT'
  );
}

function waitBeforeRetry(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.reject(new Error('Managed OpenCode admission was stopped'));
  return new Promise((resolve, reject) => {
    const onAbort = () => {
      clearTimeout(timer);
      reject(new Error('Managed OpenCode admission was stopped'));
    };
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

/** Retry bounded pre-I/O capacity and ambiguous transport failures with the same holder. */
export async function beginManagedOpenCodeWithBusyRetry<T>(
  begin: () => Promise<T>,
  signal: AbortSignal,
  shouldStop: () => boolean,
  wait: (ms: number, signal: AbortSignal) => Promise<void> = waitBeforeRetry,
  random: () => number = Math.random
): Promise<T> {
  let busyAttempts = 0;
  let transportAttempts = 0;
  for (;;) {
    if (signal.aborted || shouldStop()) throw new Error('Managed OpenCode admission was stopped');
    try {
      return await begin();
    } catch (error) {
      if (isRetryableTransportFailure(error) && transportAttempts < TRANSPORT_DELAYS_MS.length) {
        await wait(TRANSPORT_DELAYS_MS[transportAttempts++], signal);
        continue;
      }
      if (!isObserverBusy(error) || busyAttempts >= OBSERVER_BUSY_DELAYS_MS.length) throw error;
      const base = OBSERVER_BUSY_DELAYS_MS[busyAttempts++];
      const jitter = Math.floor(random() * Math.min(100, base / 4));
      await wait(base + jitter, signal);
    }
  }
}

export interface ManagedOpenCodeNativeStateManifest {
  version: 3;
  attemptTaskId: string;
  storeId: string;
  digest: string;
  bytes: number;
  openCodeSessionId: string;
  openCodeVersion: string;
  publishedAt: string;
}

export interface ManagedOpenCodeAttemptGrant {
  task_id: string;
  store_id: string;
  holder_instance_id: string;
  input_store_id: string | null;
  input_task_id: string | null;
  input_read_closed_at: string | null;
  write_state: 'open' | 'sealed' | 'abandoned';
  sealed_manifest: ManagedOpenCodeNativeStateManifest | null;
  retired_at: string | null;
}

export interface ManagedOpenCodeAdmission {
  outcome: 'admitted';
  attempt: ManagedOpenCodeAttemptGrant;
  input: ManagedOpenCodeNativeStateManifest | null;
}
