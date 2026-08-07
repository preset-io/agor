import { createRequire } from 'node:module';
import { isAbsolute, join, relative, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  AGENTIC_TOOL_INTEGRATIONS,
  getAgenticToolInstallDir,
  type InstallableAgenticTool,
} from '@agor/core/agentic-integrations';
import {
  getAgenticToolInstallSlug,
  readManagedIntegrationManifest,
} from './agentic-tool-integrations.js';

export type AgenticToolDiagnostic = {
  id: InstallableAgenticTool;
  name: string;
  kind: 'managed-integration';
  status: 'ready' | 'missing' | 'unusable';
  path?: string;
  version?: string;
  detail?: string;
  docsUrl: string;
};

const DOCS_BASE = 'https://agor.live/guide/extended-install';

async function diagnoseManagedIntegration(
  tool: InstallableAgenticTool,
  agorVersion: string
): Promise<AgenticToolDiagnostic> {
  const definition = AGENTIC_TOOL_INTEGRATIONS[tool];
  const installDir = getAgenticToolInstallDir(tool, agorVersion);
  const manifest = await readManagedIntegrationManifest(tool, agorVersion);
  if (!manifest) {
    return {
      id: tool,
      name: definition.displayName,
      kind: 'managed-integration',
      status: 'missing',
      detail: `Run: agor install ${getAgenticToolInstallSlug(tool)}`,
      docsUrl: DOCS_BASE,
    };
  }

  try {
    const require = createRequire(join(installDir, 'package.json'));
    const entry = require.resolve(definition.packageName);
    const relativeEntry = relative(installDir, entry);
    if (
      relativeEntry.startsWith(`..${sep}`) ||
      relativeEntry === '..' ||
      isAbsolute(relativeEntry)
    ) {
      throw new Error('integration resolved outside its managed directory');
    }
    const integration = (await import(pathToFileURL(entry).href)) as {
      AGOR_INTEGRATION_VERSION?: string;
      sdk?: unknown;
    };
    if (integration.AGOR_INTEGRATION_VERSION !== agorVersion || !integration.sdk) {
      throw new Error('integration module failed its version check');
    }
    return {
      id: tool,
      name: definition.displayName,
      kind: 'managed-integration',
      status: 'ready',
      path: installDir,
      version: manifest.packageVersion,
      docsUrl: DOCS_BASE,
    };
  } catch (error) {
    return {
      id: tool,
      name: definition.displayName,
      kind: 'managed-integration',
      status: 'unusable',
      path: installDir,
      detail: `${error instanceof Error ? error.message : String(error)}. Run: agor install ${getAgenticToolInstallSlug(tool)}`,
      docsUrl: DOCS_BASE,
    };
  }
}

export async function diagnoseAgenticTools(agorVersion: string): Promise<AgenticToolDiagnostic[]> {
  return Promise.all(
    (Object.keys(AGENTIC_TOOL_INTEGRATIONS) as InstallableAgenticTool[]).map((tool) =>
      diagnoseManagedIntegration(tool, agorVersion)
    )
  );
}
