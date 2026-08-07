import { createRequire } from 'node:module';
import { homedir } from 'node:os';
import { isAbsolute, join, relative, sep } from 'node:path';
import { pathToFileURL } from 'node:url';

export const AGENTIC_TOOL_INTEGRATIONS = {
  'claude-code': {
    packageName: '@agor/claude',
    vendorPackage: '@anthropic-ai/claude-agent-sdk',
    displayName: 'Claude Code',
  },
  codex: { packageName: '@agor/codex', vendorPackage: '@openai/codex-sdk', displayName: 'Codex' },
  copilot: {
    packageName: '@agor/copilot',
    vendorPackage: '@github/copilot-sdk',
    displayName: 'GitHub Copilot',
  },
  gemini: {
    packageName: '@agor/gemini',
    vendorPackage: '@google/gemini-cli-core',
    displayName: 'Gemini',
  },
  opencode: {
    packageName: '@agor/opencode',
    vendorPackage: '@opencode-ai/sdk',
    displayName: 'OpenCode',
  },
  cursor: { packageName: '@agor/cursor', vendorPackage: '@cursor/sdk', displayName: 'Cursor' },
} as const;

export type InstallableAgenticTool = keyof typeof AGENTIC_TOOL_INTEGRATIONS;

export function isInstallableAgenticTool(value: string): value is InstallableAgenticTool {
  return Object.hasOwn(AGENTIC_TOOL_INTEGRATIONS, value);
}

export function getAgenticToolsRoot(): string {
  return process.env.AGOR_AGENTIC_TOOLS_DIR ?? join(homedir(), '.agor', 'agentic-tools');
}

export function getAgenticToolInstallDir(
  tool: InstallableAgenticTool,
  agorVersion: string
): string {
  return join(getAgenticToolsRoot(), agorVersion, tool);
}

/**
 * Load an SDK from Agor's isolated, version-aligned integration tree.
 * Source checkouts use workspace dependencies unless managed mode is explicitly enabled.
 */
export async function loadManagedAgenticToolSdk<T>(tool: InstallableAgenticTool): Promise<T> {
  const definition = AGENTIC_TOOL_INTEGRATIONS[tool];
  const installSlug = tool === 'claude-code' ? 'claude' : tool;
  if (process.env.AGOR_MANAGED_AGENTIC_TOOLS !== '1') {
    return import(definition.vendorPackage) as Promise<T>;
  }

  const agorVersion = process.env.AGOR_VERSION;
  if (!agorVersion) throw new Error('AGOR_VERSION is missing from the packaged Agor runtime');
  const installDir = getAgenticToolInstallDir(tool, agorVersion);
  const require = createRequire(join(installDir, 'package.json'));
  let integrationEntry: string;
  try {
    integrationEntry = require.resolve(definition.packageName);
    const relativeEntry = relative(installDir, integrationEntry);
    if (
      relativeEntry.startsWith(`..${sep}`) ||
      relativeEntry === '..' ||
      isAbsolute(relativeEntry)
    ) {
      throw new Error('resolved outside the managed integration directory');
    }
  } catch {
    throw new Error(
      `${definition.displayName} support is not installed for Agor ${agorVersion}. Run: agor install ${installSlug}`
    );
  }
  const integration = (await import(pathToFileURL(integrationEntry).href)) as {
    AGOR_INTEGRATION_VERSION?: string;
    sdk?: T;
  };
  if (integration.AGOR_INTEGRATION_VERSION !== agorVersion || !integration.sdk) {
    throw new Error(
      `${definition.displayName} support does not match Agor ${agorVersion}. Run: agor install ${installSlug}`
    );
  }
  return integration.sdk;
}
