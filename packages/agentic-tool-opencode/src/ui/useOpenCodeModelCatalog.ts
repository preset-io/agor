import type { AgorClient } from '@agor/core/client';
import type { OpenCodeModelCatalog } from '@agor/core/types';
import { useCallback, useEffect, useSyncExternalStore } from 'react';
import { createOpenCodeKnownModelCatalog, OPENCODE_VERSION } from '../shared/known-models.js';

interface CatalogState {
  catalog: OpenCodeModelCatalog;
  availabilityResolved: boolean;
  loading: boolean;
  refreshFailed: boolean;
  stale: boolean;
}

interface CatalogEntry {
  client: AgorClient;
  authentication: unknown;
  state: CatalogState;
  request?: Promise<void>;
  revision: number;
  listeners: Set<() => void>;
}

const IMMEDIATE_CATALOG: OpenCodeModelCatalog = {
  runtimeVersion: OPENCODE_VERSION,
  providers: createOpenCodeKnownModelCatalog(null).providers,
};
const DISABLED_STATE: CatalogState = {
  catalog: IMMEDIATE_CATALOG,
  availabilityResolved: false,
  loading: false,
  refreshFailed: false,
  stale: false,
};
const resources = new WeakMap<AgorClient, Map<unknown, CatalogEntry>>();

function publish(entry: CatalogEntry, state: CatalogState): void {
  entry.state = state;
  for (const listener of entry.listeners) listener();
}

function entriesFor(client: AgorClient): Map<unknown, CatalogEntry> {
  let entries = resources.get(client);
  if (entries) return entries;
  entries = new Map();
  resources.set(client, entries);
  client.on?.('authenticated', () => {
    for (const entry of entries?.values() ?? []) {
      entry.revision += 1;
      publish(entry, { ...DISABLED_STATE, stale: true });
    }
    entries?.clear();
  });
  return entries;
}

function entryFor(client: AgorClient): CatalogEntry {
  const authentication = client.get?.('authentication');
  const entries = entriesFor(client);
  let entry = entries.get(authentication);
  if (!entry) {
    entry = {
      client,
      authentication,
      state: { ...DISABLED_STATE, stale: true },
      revision: 0,
      listeners: new Set(),
    };
    entries.set(authentication, entry);
  }
  return entry;
}

async function load(entry: CatalogEntry, force = false): Promise<void> {
  if (entry.client.get?.('authentication') !== entry.authentication) return;
  if (entry.request) return entry.request;
  if (!force && !entry.state.stale) return;

  publish(entry, { ...entry.state, loading: true, refreshFailed: false, stale: false });
  const revision = entry.revision;
  const request = (async () => {
    try {
      const catalog = await entry.client.service('opencode-models').find();
      if (
        entry.revision === revision &&
        entry.client.get?.('authentication') === entry.authentication
      ) {
        publish(entry, {
          catalog,
          availabilityResolved: true,
          loading: false,
          refreshFailed: false,
          stale: false,
        });
      }
    } catch {
      if (
        entry.revision === revision &&
        entry.client.get?.('authentication') === entry.authentication
      ) {
        publish(entry, { ...entry.state, loading: false, refreshFailed: true, stale: false });
      }
    } finally {
      entry.request = undefined;
      if (entry.state.stale && entry.listeners.size > 0) void load(entry);
    }
  })();
  entry.request = request;
  return request;
}

/** Re-reads configured-provider evidence after an OpenCode auth mutation. */
export function invalidateOpenCodeModelCatalog(client: AgorClient): void {
  const entry = entriesFor(client).get(client.get?.('authentication'));
  if (!entry) return;
  entry.revision += 1;
  publish(entry, { ...DISABLED_STATE, stale: true });
}

/** Immediate fixed choices plus one shared, server-free configured-provider read. */
export function useOpenCodeModelCatalog(input: {
  client?: AgorClient | null;
  catalogEnabled: boolean;
}) {
  const { client, catalogEnabled } = input;
  const entry = client && catalogEnabled ? entryFor(client) : null;
  const state = useSyncExternalStore(
    useCallback(
      (listener) => {
        if (!entry) return () => undefined;
        entry.listeners.add(listener);
        return () => entry.listeners.delete(listener);
      },
      [entry]
    ),
    useCallback(() => entry?.state ?? DISABLED_STATE, [entry]),
    () => DISABLED_STATE
  );

  useEffect(() => {
    if (entry) void load(entry, state.stale);
  }, [entry, state.stale]);

  const refresh = useCallback(async () => {
    if (entry) await load(entry, true);
  }, [entry]);

  return {
    catalog: catalogEnabled ? state.catalog : null,
    availabilityResolved: state.availabilityResolved,
    loading: state.loading,
    refreshFailed: state.refreshFailed,
    refresh,
  };
}
