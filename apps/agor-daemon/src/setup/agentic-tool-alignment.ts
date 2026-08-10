import {
  inspectManagedAgenticToolAlignment,
  resolveAgenticToolSelectionPolicy,
  resolveManagedAgenticToolVersion,
} from '@agor/core/agentic-integrations';
import type { AgorConfig } from '@agor/core/config';

/**
 * Fail before the daemon listens when deployment-selected integrations do not
 * exactly match this packaged Agor runtime. Source checkouts use workspace
 * dependencies and intentionally skip the managed-package contract.
 */
export async function assertConfiguredAgenticToolsAligned(
  config: AgorConfig,
  env: NodeJS.ProcessEnv = process.env
): Promise<
  readonly import('@agor/core/agentic-integrations').InstallableAgenticTool[] | undefined
> {
  if (env.AGOR_MANAGED_AGENTIC_TOOLS !== '1') return undefined;

  const agorVersion = resolveManagedAgenticToolVersion(undefined, env);
  if (!agorVersion) {
    throw new Error(
      'Managed agentic tools are enabled, but AGOR_VERSION is unavailable. Reinstall the agor-live package.'
    );
  }

  const policy = await resolveAgenticToolSelectionPolicy(config);
  const configured = policy.selected;
  if (policy.source === 'missing-manifest') {
    console.warn(
      '⚠️  No agentic tools are selected. Run `agor install` interactively before creating agent sessions.'
    );
  }
  const state = await inspectManagedAgenticToolAlignment(configured, agorVersion);
  const invalid = state.filter((item) => item.status !== 'ready');
  if (invalid.length === 0) return configured;

  const lines = invalid.map(
    (item) =>
      `  - ${item.displayName}: missing or invalid (expected ${item.expectedVersion})${item.detail ? `; ${item.detail}` : ''}`
  );
  throw new Error(
    [
      `Configured agentic tool packages are not aligned with Agor ${agorVersion}:`,
      ...lines,
      '',
      'Run `agor install --sync` as the daemon user to repair the selected versions and remove stale packages.',
      'Inspect without changing anything with `agor doctor`.',
    ].join('\n')
  );
}
