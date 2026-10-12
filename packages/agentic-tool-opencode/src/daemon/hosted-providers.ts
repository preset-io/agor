import type {
  OpenCodeModelCatalog,
  OpenCodeProviderConnection,
  OpenCodeProviderDiscovery,
} from '@agor/core/types';
import { OPENCODE_VERSION } from '../shared/known-models.js';
import { HOSTED_OPENCODE_PROVIDER_LINES } from './hosted-providers.generated.js';

interface HostedProvider {
  id: string;
  name: string;
  model?: string;
  models: Array<[id: string, name?: string]>;
}

let cache: Map<string, HostedProvider> | undefined;

/** Single-key providers hosted OpenCode can run, from the snapshot of the pinned OpenCode. */
function hostedProviders(): Map<string, HostedProvider> {
  cache ??= new Map(
    HOSTED_OPENCODE_PROVIDER_LINES.map((line) => {
      const provider = JSON.parse(line) as HostedProvider;
      return [provider.id, provider];
    })
  );
  return cache;
}

export function isHostedOpenCodeProvider(providerId: string): boolean {
  return hostedProviders().has(providerId);
}

function models(provider: HostedProvider) {
  return provider.models.map(([id, name]) => ({ id, name: name ?? id, status: 'active' as const }));
}

/** Model choices: providers with a saved key are selectable; the first one with a default model is suggested. */
export function hostedOpenCodeModelCatalog(
  savedProviderIds: ReadonlySet<string>
): Omit<OpenCodeModelCatalog, 'runtimeVersion'> {
  const all = [...hostedProviders().values()];
  const suggested = all.find((provider) => savedProviderIds.has(provider.id) && provider.model);
  return {
    ...(suggested?.model
      ? { suggestedSelection: { providerId: suggested.id, modelId: suggested.model } }
      : {}),
    providers: all.map((provider) => ({
      id: provider.id,
      name: provider.name,
      availableForSelection: savedProviderIds.has(provider.id),
      ...(provider.model ? { suggestedModel: provider.model } : {}),
      models: models(provider),
    })),
  };
}

/** Settings list (models come from the catalog); saved keys for providers that left the snapshot stay visible so they can be removed. */
export function hostedOpenCodeProviderDiscovery(
  savedProviderIds: ReadonlySet<string>
): OpenCodeProviderDiscovery {
  const known = hostedProviders();
  const providers: OpenCodeProviderConnection[] = [...known.values()].map((provider) => ({
    id: provider.id,
    name: provider.name,
    runtimeAvailable: savedProviderIds.has(provider.id),
    credentialPresence: savedProviderIds.has(provider.id) ? 'present' : 'absent',
    authMethods: [{ index: 0, type: 'api', label: 'API key' }],
    models: [],
  }));
  for (const id of savedProviderIds) {
    if (known.has(id)) continue;
    providers.push({
      id,
      name: id,
      runtimeAvailable: false,
      credentialPresence: 'present',
      authMethods: [],
      models: [],
    });
  }
  return {
    runtime: 'available',
    runtimeVersion: OPENCODE_VERSION,
    providers,
  };
}
