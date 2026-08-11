import { BadRequest } from '@agor/core/feathers';
import {
  releaseExecutorContainmentFenceIntent,
  reserveExecutorContainmentFence,
  verifyExecutorContainmentFence,
} from '../../executor-tracking.js';
import type { ContainedExecutorCommandHandle } from '../../utils/spawn-executor.js';

const mutationSlots = new Map<string, Promise<void>>();
const blockedNamespaces = new Map<string, Set<() => Promise<boolean>>>();
const CLEANUP_UNVERIFIED_MESSAGE =
  'OpenCode provider cleanup could not be verified. Later mutations remain blocked.';

type CleanupFenceHandle = Pick<
  ContainedExecutorCommandHandle,
  'retainContainmentFence' | 'verifyAbsence'
>;

function containmentFenceKey(namespaceKey: string): string {
  return `opencode-native-state:${namespaceKey}`;
}

export async function blockOpenCodeNativeStateNamespace(
  key: string,
  handle: CleanupFenceHandle
): Promise<void> {
  const verifiers = blockedNamespaces.get(key) ?? new Set();
  verifiers.add(handle.verifyAbsence);
  blockedNamespaces.set(key, verifiers);
  try {
    await handle.retainContainmentFence(containmentFenceKey(key));
  } catch {
    throw new BadRequest(CLEANUP_UNVERIFIED_MESSAGE);
  }
}

async function verifyBlockedNamespace(key: string): Promise<void> {
  const verifiers = blockedNamespaces.get(key);
  if (verifiers) {
    await Promise.all(
      [...verifiers].map(async (verifyAbsence) => {
        try {
          if (await verifyAbsence()) verifiers.delete(verifyAbsence);
        } catch {
          // Existing containment owns details; the public service stays secret-safe.
        }
      })
    );
  }
  if (blockedNamespaces.get(key)?.size) {
    throw new BadRequest(CLEANUP_UNVERIFIED_MESSAGE);
  }
  const durableFenceVerified = await verifyExecutorContainmentFence(containmentFenceKey(key)).catch(
    () => false
  );
  const activeVerifiers = blockedNamespaces.get(key);
  if (!durableFenceVerified || activeVerifiers?.size) {
    throw new BadRequest(CLEANUP_UNVERIFIED_MESSAGE);
  }
  if (activeVerifiers === verifiers) blockedNamespaces.delete(key);
}

export interface OpenCodeNativeStateMutationFence {
  /** Replace the pre-spawn intent only after this writer's process identity is durable. */
  attach(handle: CleanupFenceHandle): Promise<void>;
  /** Release an intent only when the integration proves no writer was started. */
  releaseWithoutWriter(): Promise<void>;
}

/**
 * Serializes native-state mutation and persists a fail-closed intent before the
 * writer can start. Restart can never erase the only evidence of an active or
 * ambiguously-started writer.
 */
export async function inOpenCodeNativeStateMutationSlot<T>(
  key: string,
  work: (fence: OpenCodeNativeStateMutationFence) => Promise<T>
): Promise<T> {
  const previous = mutationSlots.get(key) ?? Promise.resolve();
  const current = previous
    .catch(() => undefined)
    .then(async () => {
      await verifyBlockedNamespace(key);
      const fenceKey = containmentFenceKey(key);
      const intentId = await reserveExecutorContainmentFence(fenceKey);
      let attached = false;
      let releasedWithoutWriter = false;

      const fence: OpenCodeNativeStateMutationFence = {
        async attach(handle) {
          if (attached || releasedWithoutWriter) {
            throw new Error('OpenCode native-state mutation fence is already settled');
          }
          try {
            await handle.retainContainmentFence(fenceKey);
            await releaseExecutorContainmentFenceIntent(fenceKey, intentId);
            attached = true;
          } catch {
            // The durable intent remains. A restart therefore fails closed even
            // if the child started before its process identity was persisted.
            throw new BadRequest(CLEANUP_UNVERIFIED_MESSAGE);
          }
        },
        async releaseWithoutWriter() {
          if (attached || releasedWithoutWriter) {
            throw new Error('OpenCode native-state mutation fence is already settled');
          }
          await releaseExecutorContainmentFenceIntent(fenceKey, intentId);
          releasedWithoutWriter = true;
        },
      };

      const result = await work(fence);
      if (releasedWithoutWriter) return result;
      if (!attached) throw new BadRequest(CLEANUP_UNVERIFIED_MESSAGE);
      if (!(await verifyExecutorContainmentFence(fenceKey).catch(() => false))) {
        throw new BadRequest(CLEANUP_UNVERIFIED_MESSAGE);
      }
      return result;
    });
  const settled = current.then(
    () => undefined,
    () => undefined
  );
  mutationSlots.set(key, settled);
  try {
    return await current;
  } finally {
    if (mutationSlots.get(key) === settled) mutationSlots.delete(key);
  }
}
