import { BadRequest } from '@agor/core/feathers';

const mutationSlots = new Map<string, Promise<void>>();
const blockedNamespaces = new Map<string, Set<() => Promise<boolean>>>();

export function blockOpenCodeNativeStateNamespace(
  key: string,
  verifyAbsence: () => Promise<boolean>
): void {
  const verifiers = blockedNamespaces.get(key) ?? new Set();
  verifiers.add(verifyAbsence);
  blockedNamespaces.set(key, verifiers);
}

async function verifyBlockedNamespace(key: string): Promise<void> {
  const verifiers = blockedNamespaces.get(key);
  if (!verifiers) return;

  await Promise.all(
    [...verifiers].map(async (verifyAbsence) => {
      try {
        if (await verifyAbsence()) verifiers.delete(verifyAbsence);
      } catch {
        // Existing containment owns details; the public service stays secret-safe.
      }
    })
  );
  if (verifiers.size > 0) {
    throw new BadRequest(
      'OpenCode provider cleanup could not be verified. Later mutations remain blocked.'
    );
  }
  if (blockedNamespaces.get(key) === verifiers) blockedNamespaces.delete(key);
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
