import type { AgorClient } from '@agor/core/client';
import type {
  EffortLevel,
  OpenCodeModelCatalog,
  OpenCodeProviderDiscovery,
} from '@agor/core/types';
import { useCallback, useEffect, useSyncExternalStore } from 'react';
import { useOpenCodeModelCatalog } from './useOpenCodeModelCatalog.js';

interface DiscoveryState {
  discovery: OpenCodeProviderDiscovery | null;
  loading: boolean;
  failed: boolean;
}

interface DiscoveryEntry {
  client: AgorClient;
  authentication: unknown;
  branchId: string;
  state: DiscoveryState;
  request?: Promise<void>;
  revision: number;
  listeners: Set<() => void>;
}

const EMPTY_DISCOVERY_STATE: DiscoveryState = {
  discovery: null,
  loading: false,
  failed: false,
};
const discoveryResources = new WeakMap<AgorClient, Map<unknown, Map<string, DiscoveryEntry>>>();

function publish(entry: DiscoveryEntry, state: DiscoveryState): void {
  entry.state = state;
  for (const listener of entry.listeners) listener();
}

function resourcesFor(client: AgorClient): Map<unknown, Map<string, DiscoveryEntry>> {
  let resources = discoveryResources.get(client);
  if (resources) return resources;
  resources = new Map();
  discoveryResources.set(client, resources);
  client.on?.('authenticated', () => {
    for (const entries of resources?.values() ?? []) {
      for (const entry of entries.values()) {
        entry.revision += 1;
        publish(entry, EMPTY_DISCOVERY_STATE);
      }
    }
    resources?.clear();
  });
  return resources;
}

function entryFor(client: AgorClient, branchId: string): DiscoveryEntry {
  const authentication = client.get?.('authentication');
  const resources = resourcesFor(client);
  let entries = resources.get(authentication);
  if (!entries) {
    entries = new Map();
    resources.set(authentication, entries);
  }
  let entry = entries.get(branchId);
  if (!entry) {
    entry = {
      client,
      authentication,
      branchId,
      state: EMPTY_DISCOVERY_STATE,
      revision: 0,
      listeners: new Set(),
    };
    entries.set(branchId, entry);
  }
  return entry;
}

async function load(entry: DiscoveryEntry, force = false): Promise<void> {
  if (entry.client.get?.('authentication') !== entry.authentication) return;
  if (entry.request) return entry.request;
  if (!force && (entry.state.discovery || entry.state.failed)) return;

  publish(entry, { ...entry.state, loading: true, failed: false });
  const revision = entry.revision;
  const request = (async () => {
    try {
      const discovery = await entry.client
        .service('opencode-auth')
        .find({ query: { branch_id: entry.branchId } });
      if (
        entry.revision === revision &&
        entry.client.get?.('authentication') === entry.authentication
      ) {
        publish(entry, { discovery, loading: false, failed: false });
      }
    } catch {
      if (
        entry.revision === revision &&
        entry.client.get?.('authentication') === entry.authentication
      ) {
        publish(entry, { discovery: null, loading: false, failed: true });
      }
    } finally {
      entry.request = undefined;
    }
  })();
  entry.request = request;
  return request;
}

function useOpenCodeBranchDiscovery(input: {
  client?: AgorClient | null;
  branchId?: string;
  enabled: boolean;
}): DiscoveryState & { retry: () => Promise<void> } {
  const { client, branchId, enabled } = input;
  const entry = client && branchId && enabled ? entryFor(client, branchId) : null;
  const state = useSyncExternalStore(
    useCallback(
      (listener) => {
        if (!entry) return () => undefined;
        entry.listeners.add(listener);
        return () => entry.listeners.delete(listener);
      },
      [entry]
    ),
    useCallback(() => entry?.state ?? EMPTY_DISCOVERY_STATE, [entry]),
    () => EMPTY_DISCOVERY_STATE
  );

  useEffect(() => {
    if (entry) void load(entry);
  }, [entry]);

  const retry = useCallback(async () => {
    if (entry) await load(entry, true);
  }, [entry]);

  return { ...state, retry };
}

function levelsFromCatalog(
  catalog: OpenCodeModelCatalog | null,
  provider: string,
  model: string
): readonly EffortLevel[] | undefined {
  return catalog?.providers
    ?.find((entry) => entry.id === provider)
    ?.models.find((candidate) => candidate.id === model)?.reasoningEffortLevels;
}

function levelsFromDiscovery(
  discovery: OpenCodeProviderDiscovery,
  provider: string,
  model: string
): readonly EffortLevel[] | undefined {
  return discovery.providers
    ?.find((entry) => entry.id === provider)
    ?.models.find((candidate) => candidate.id === model)?.reasoningEffortLevels;
}

/**
 * Resolves safe effort names for an exact pair. Authenticated branch discovery
 * wins whenever it succeeds; otherwise the server-free catalog remains useful
 * advisory metadata. Missing metadata stays distinct from a known empty list.
 */
export function useOpenCodeReasoningEffortLevels(input: {
  client?: AgorClient | null;
  branchId?: string;
  catalogEnabled: boolean;
  provider?: string;
  model?: string;
}) {
  const { client, branchId, catalogEnabled, provider, model } = input;
  const { catalog } = useOpenCodeModelCatalog({ client, catalogEnabled });
  const {
    discovery,
    loading: liveLoading,
    failed: liveFailed,
    retry,
  } = useOpenCodeBranchDiscovery({
    client,
    branchId,
    enabled: catalogEnabled,
  });
  const resolve = useCallback(
    (nextProvider: string, nextModel: string): readonly EffortLevel[] | undefined => {
      if (!catalogEnabled) return undefined;
      if (discovery) return levelsFromDiscovery(discovery, nextProvider, nextModel);
      return levelsFromCatalog(catalog, nextProvider, nextModel);
    },
    [catalog, catalogEnabled, discovery]
  );

  return {
    levels: provider && model ? resolve(provider, model) : undefined,
    resolve,
    liveLoading,
    liveFailed,
    retry,
  };
}
