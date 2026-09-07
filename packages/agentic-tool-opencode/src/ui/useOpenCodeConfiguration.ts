import type { AgorClient } from '@agor/core/client';
import type { OpenCodeProviderSettings } from '@agor/core/types';
import { useCallback, useEffect, useSyncExternalStore } from 'react';

interface ResourceState {
  configuration: OpenCodeProviderSettings | null;
  loading: boolean;
  loadFailed: boolean;
  /** Server-provided failure message, when the load error carried one. */
  loadError: string | undefined;
  stale: boolean;
  loadedAt: number;
}

interface ResourceEntry {
  client: AgorClient;
  authentication: unknown;
  state: ResourceState;
  request?: Promise<void>;
  revision: number;
  listeners: Set<() => void>;
}

const MAX_AGE_MS = 30_000;
const EMPTY_STATE: ResourceState = {
  configuration: null,
  loading: false,
  loadFailed: false,
  loadError: undefined,
  stale: false,
  loadedAt: 0,
};
const resources = new WeakMap<AgorClient, Map<unknown, ResourceEntry>>();

function publish(entry: ResourceEntry, state: ResourceState): void {
  entry.state = state;
  for (const listener of entry.listeners) listener();
}

function entriesFor(client: AgorClient): Map<unknown, ResourceEntry> {
  let entries = resources.get(client);
  if (entries) return entries;
  entries = new Map();
  resources.set(client, entries);
  client.on?.('authenticated', () => {
    for (const entry of entries?.values() ?? []) {
      entry.revision += 1;
      publish(entry, { ...EMPTY_STATE, stale: true });
    }
    entries?.clear();
  });
  return entries;
}

function entryFor(client: AgorClient): ResourceEntry {
  const authentication = client.get?.('authentication');
  const entries = entriesFor(client);
  let entry = entries.get(authentication);
  if (!entry) {
    entry = {
      client,
      authentication,
      state: { ...EMPTY_STATE, stale: true },
      revision: 0,
      listeners: new Set(),
    };
    entries.set(authentication, entry);
  }
  return entry;
}

async function load(entry: ResourceEntry, force = false): Promise<void> {
  if (entry.client.get?.('authentication') !== entry.authentication) return;
  if (entry.request) return entry.request;
  const fresh =
    entry.state.configuration !== null && Date.now() - entry.state.loadedAt < MAX_AGE_MS;
  if (!force && !entry.state.stale && fresh) return;

  publish(entry, {
    ...entry.state,
    loading: true,
    loadFailed: false,
    loadError: undefined,
    stale: false,
  });
  const revision = entry.revision;
  const request = (async () => {
    try {
      const configuration = await entry.client.service('opencode-auth').find();
      if (
        entry.revision === revision &&
        entry.client.get?.('authentication') === entry.authentication
      ) {
        publish(entry, {
          configuration,
          loading: false,
          loadFailed: false,
          loadError: undefined,
          stale: false,
          loadedAt: Date.now(),
        });
      }
    } catch (error) {
      if (
        entry.revision === revision &&
        entry.client.get?.('authentication') === entry.authentication
      ) {
        publish(entry, {
          ...entry.state,
          loading: false,
          loadFailed: true,
          loadError:
            error instanceof Error && error.message.trim() ? error.message.trim() : undefined,
          stale: false,
        });
      }
    } finally {
      entry.request = undefined;
      if (entry.state.stale && entry.listeners.size > 0) void load(entry);
    }
  })();
  entry.request = request;
  return request;
}

/** Publishes the result of an OpenCode provider mutation for the current caller. */
export function publishOpenCodeConfiguration(
  client: AgorClient,
  configuration: OpenCodeProviderSettings
): void {
  const entry = entryFor(client);
  entry.revision += 1;
  publish(entry, {
    configuration,
    loading: false,
    loadFailed: false,
    loadError: undefined,
    stale: false,
    loadedAt: Date.now(),
  });
}

/** Shared OpenCode-owned provider-management snapshot for the authenticated caller. */
export function useOpenCodeConfiguration(input: { client?: AgorClient | null; enabled: boolean }) {
  const { client, enabled } = input;
  const entry = client && enabled ? entryFor(client) : null;
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
