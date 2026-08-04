import { BadRequest } from '@agor/core/feathers';
import { verifyExecutorContainmentFence } from '../../executor-tracking.js';
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

/** Serializes credential mutation and retains the fence after unverified cleanup. */
export async function inOpenCodeNativeStateMutationSlot<T>(
  key: string,
  work: () => Promise<T>
): Promise<T> {
  const previous = mutationSlots.get(key) ?? Promise.resolve();
  const current = previous
    .catch(() => undefined)
    .then(async () => {
      await verifyBlockedNamespace(key);
      return work();
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
