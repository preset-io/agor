import { loadManagedAgenticToolSdk } from '@agor/core/agentic-integrations';

export type OpenCodeSdk = typeof import('@opencode/client');
export type OpenCodeSdkV2 = OpenCodeSdk;

export async function loadOpenCodeSdk(): Promise<OpenCodeSdk> {
  // Source checkouts install the SDK in this package's dependency scope. Keep
  // the import here so pnpm/Node resolve it from agentic-tool-opencode rather
  // than from @agor/core, which intentionally does not ship vendor runtimes.
  if (process.env.AGOR_MANAGED_AGENTIC_TOOLS !== '1') return import('@opencode/client');
  return loadManagedAgenticToolSdk<OpenCodeSdk>('opencode');
}

export async function loadOpenCodeSdkV2(): Promise<OpenCodeSdkV2> {
  return loadOpenCodeSdk();
}
