import {
  loadManagedAgenticToolSdk,
  resolveManagedAgenticToolIntegration,
} from '@agor/core/agentic-integrations';

export type OpenCodeSdk = typeof import('@opencode-ai/sdk');
export type OpenCodeSdkV2 = typeof import('@opencode-ai/sdk/v2');

export async function loadOpenCodeSdk(): Promise<OpenCodeSdk> {
  // Source checkouts install the SDK in this package's dependency scope. Keep
  // the import here so pnpm/Node resolve it from agentic-tool-opencode rather
  // than from @agor/core, which intentionally does not ship vendor runtimes.
  if (process.env.AGOR_MANAGED_AGENTIC_TOOLS !== '1') return import('@opencode-ai/sdk');
  return loadManagedAgenticToolSdk<OpenCodeSdk>('opencode');
}

export async function loadOpenCodeSdkV2(): Promise<OpenCodeSdkV2> {
  if (process.env.AGOR_MANAGED_AGENTIC_TOOLS !== '1') return import('@opencode-ai/sdk/v2');
  const agorVersion = process.env.AGOR_VERSION;
  if (!agorVersion) throw new Error('AGOR_VERSION is missing from the packaged Agor runtime');
  const integration = await resolveManagedAgenticToolIntegration<OpenCodeSdk>(
    'opencode',
    agorVersion
  );
  if (integration.AGOR_INTEGRATION_VERSION !== agorVersion || !integration.sdkV2) {
    throw new Error(`OpenCode support does not match Agor ${agorVersion}. Run: agor install`);
  }
  return integration.sdkV2 as OpenCodeSdkV2;
}
