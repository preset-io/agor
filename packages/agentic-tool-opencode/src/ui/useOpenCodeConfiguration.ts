import type { AgorClient } from '@agor/core/client';
import type { OpenCodeProviderSettings } from '@agor/core/types';
import { useCallback, useEffect, useSyncExternalStore } from 'react';

interface ResourceState {
  configuration: OpenCodeProviderSettings | null;
  loading: boolean;
  loadFailed: boolean;
  stale: boolean;
  loadedAt: number;
}

interface ResourceEntry {
  client: AgorClient;
  authentication: unknown;
  branchId?: string;
  state: ResourceState;
  request?: Promise<void>;
  revision: number;
  listeners: Set<() => void>;
}

interface ClientResources {
  entries: Map<string, ResourceEntry>;
}

interface ClientResourceOwner {
  scopes: Map<unknown, ClientResources>;
}

const MAX_AGE_MS = 30_000;
const EMPTY_STATE: ResourceState = {
  configuration: null,
  loading: false,
  loadFailed: false,
  stale: false,
  loadedAt: 0,
};
const resources = new WeakMap<AgorClient, ClientResourceOwner>();

function scopeKey(branchId: string | undefined): string {
  return branchId ? `branch:${branchId}` : 'user';
}

function invalidate(entry: ResourceEntry): void {
  entry.revision += 1;
  publish(entry, { ...EMPTY_STATE, stale: true });
}

function resourcesFor(client: AgorClient, authentication: unknown): ClientResources {
  let owner = resources.get(client);
  if (!owner) {
    const created: ClientResourceOwner = {
      scopes: new Map(),
    };
    resources.set(client, created);
    client.on?.('authenticated', () => {
      const currentAuthentication = client.get?.('authentication');
      for (const [scopeAuthentication, scope] of created.scopes) {
        if (scopeAuthentication === currentAuthentication) continue;
        for (const entry of scope.entries.values()) invalidate(entry);
        created.scopes.delete(scopeAuthentication);
      }
    });
    owner = created;
  }
  let clientResources = owner.scopes.get(authentication);
  if (!clientResources) {
    clientResources = { entries: new Map() };
    owner.scopes.set(authentication, clientResources);
  }
  return clientResources;
}

function entryFor(client: AgorClient, branchId: string | undefined): ResourceEntry {
  const authentication = client.get?.('authentication');
  const clientResources = resourcesFor(client, authentication).entries;
  const key = scopeKey(branchId);
  let entry = clientResources.get(key);
  if (!entry) {
    entry = {
      client,
      authentication,
      branchId,
      state: { ...EMPTY_STATE, stale: true },
      revision: 0,
      listeners: new Set(),
    };
    clientResources.set(key, entry);
  }
  return entry;
}

function publish(entry: ResourceEntry, state: ResourceState): void {
  entry.state = state;
  for (const listener of entry.listeners) listener();
}

async function load(entry: ResourceEntry, force = false): Promise<void> {
  if (entry.client.get?.('authentication') !== entry.authentication) return;
  if (entry.request) return entry.request;
  const isFresh =
    entry.state.configuration !== null && Date.now() - entry.state.loadedAt < MAX_AGE_MS;
  if (!force && !entry.state.stale && isFresh) return;

  publish(entry, { ...entry.state, loading: true, loadFailed: false, stale: false });
  const revision = entry.revision;
  const request = (async () => {
    try {
      const service = entry.client.service('opencode-auth');
      const configuration = entry.branchId
        ? await service.find({ query: { branch_id: entry.branchId } })
        : await service.find();
      if (
        entry.revision === revision &&
        entry.client.get?.('authentication') === entry.authentication
      ) {
        publish(entry, {
          configuration,
          loading: false,
          loadFailed: false,
          stale: false,
          loadedAt: Date.now(),
        });
      }
    } catch {
      if (
        entry.revision === revision &&
        entry.client.get?.('authentication') === entry.authentication
      ) {
        publish(entry, {
          ...entry.state,
          loading: false,
          loadFailed: true,
          stale: false,
        });
      }
    } finally {
      entry.request = undefined;
      if (
        entry.client.get?.('authentication') === entry.authentication &&
        entry.state.stale &&
        entry.listeners.size > 0
      ) {
        void load(entry);
      }
    }
  })();
  entry.request = request;
  return request;
}

/** Publishes a mutation result and invalidates branch-aware snapshots for this caller. */
export function publishOpenCodeConfiguration(
  client: AgorClient,
  configuration: OpenCodeProviderSettings
): void {
  const clientResources = resourcesFor(client, client.get?.('authentication'));
  const userEntry = entryFor(client, undefined);
  userEntry.revision += 1;
  publish(userEntry, {
    configuration,
    loading: false,
    loadFailed: false,
    stale: false,
    loadedAt: Date.now(),
  });
  for (const entry of clientResources.entries.values()) {
    if (!entry.branchId) continue;
    invalidate(entry);
  }
}

/** Shared OpenCode-owned configuration read for provider settings and model selectors. */
export function useOpenCodeConfiguration(input: {
  client?: AgorClient | null;
  branchId?: string;
  enabled: boolean;
}) {
  const { client, branchId, enabled } = input;
  const entry = client && enabled ? entryFor(client, branchId) : null;
  const state = useSyncExternalStore(
    useCallback(
      (listener) => {
        if (!entry) return () => undefined;
        entry.listeners.add(listener);
        return () => entry.listeners.delete(listener);
      },
      [entry]
    ),
    useCallback(() => entry?.state ?? EMPTY_STATE, [entry]),
    () => EMPTY_STATE
  );

  useEffect(() => {
    if (entry) void load(entry, state.stale);
  }, [entry, state.stale]);

  const retry = useCallback(async () => {
    if (entry) await load(entry, true);
  }, [entry]);

  return { ...state, retry };
}
