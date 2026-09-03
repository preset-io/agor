import type { ExecutorSessionTokenRevocation } from './executor-session-token.js';

const CANDIDATE = Symbol('agor.executor-connection-candidate');

/**
 * Trusted executor scope produced by durable token validation but not yet
 * admitted as a live Socket.IO connection.
 *
 * The generation closes the interval between the asynchronous authority read
 * and Socket.IO's synchronous pending-to-active handoff. It is deliberately a
 * private authentication-result attachment: callers cannot submit this scope
 * as token or service data.
 */
export interface ExecutorConnectionCandidate {
  tenantId: string;
  taskId?: string;
  tokenFingerprint: string;
  revocationGeneration: number;
  /** Present only for a retained, exact workload-completion receipt login. */
  completionReceipt?: {
    taskId: string;
    sessionId: string;
    resultMessageId: string;
  };
}

type CandidateCarrier = { [CANDIDATE]?: ExecutorConnectionCandidate };

/**
 * Process-local admission epoch for executor token revocation.
 *
 * Durable token authority rejects revocations committed before validation.
 * This epoch covers revocation observed after validation begins but before the
 * connection enters Socket.IO's active socket map. Once active, exact-token
 * socket scanning owns retirement.
 */
export class ExecutorConnectionRevocationFence {
  private readonly tenantGenerations = new Map<string, number>();

  snapshot(tenantId: string): number {
    return this.tenantGenerations.get(tenantId) ?? 0;
  }

  record(revocation: ExecutorSessionTokenRevocation): void {
    const tenantId = revocation.tenantId;
    if (!tenantId) return;
    this.tenantGenerations.set(tenantId, this.snapshot(tenantId) + 1);
  }

  isCurrent(tenantId: string, generation: number): boolean {
    return generation === this.snapshot(tenantId);
  }
}

const fencesByApp = new WeakMap<object, ExecutorConnectionRevocationFence>();

export function getOrCreateExecutorConnectionRevocationFence(
  app: object
): ExecutorConnectionRevocationFence {
  let fence = fencesByApp.get(app);
  if (!fence) {
    fence = new ExecutorConnectionRevocationFence();
    fencesByApp.set(app, fence);
  }
  return fence;
}

export function attachExecutorConnectionCandidate(
  authResult: object,
  candidate: ExecutorConnectionCandidate
): void {
  Object.defineProperty(authResult, CANDIDATE, {
    configurable: true,
    enumerable: false,
    value: candidate,
  });
}

export function getExecutorConnectionCandidate(
  authResult: unknown
): ExecutorConnectionCandidate | undefined {
  return authResult && typeof authResult === 'object'
    ? (authResult as CandidateCarrier)[CANDIDATE]
    : undefined;
}
