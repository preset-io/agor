import { constants as fsConstants } from 'node:fs';
import { access, readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { OPENCODE_VERSION } from '../shared/known-models.js';

type PackageLocation = { packageJsonPath: string; version: string };

async function findPackageLocation(
  entryPath: string,
  packageName: string
): Promise<PackageLocation> {
  let current = dirname(entryPath);
  for (;;) {
    const packageJsonPath = join(current, 'package.json');
    try {
      const parsed = JSON.parse(await readFile(packageJsonPath, 'utf8')) as {
        name?: string;
        version?: string;
      };
      if (parsed.name === packageName && parsed.version) {
        return { packageJsonPath, version: parsed.version };
      }
    } catch {
      // Keep walking toward the package root.
    }
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
  throw new Error(`OpenCode package ${packageName} is not installed correctly`);
}

export async function resolvePackagedOpenCodeBinary(): Promise<string> {
  const require = createRequire(import.meta.url);
  let cli: PackageLocation;
  let sdk: PackageLocation;
  try {
    cli = await findPackageLocation(require.resolve('opencode-ai/package.json'), 'opencode-ai');
    sdk = await findPackageLocation(
      fileURLToPath(import.meta.resolve('@opencode-ai/sdk')),
      '@opencode-ai/sdk'
    );
  } catch (error) {
    throw new Error(
      `OpenCode ${OPENCODE_VERSION} is not fully installed; reinstall Agor with optional dependencies enabled`,
      { cause: error }
    );
  }

  if (cli.version !== OPENCODE_VERSION || sdk.version !== OPENCODE_VERSION) {
    throw new Error(
      `OpenCode SDK/CLI mismatch: expected ${OPENCODE_VERSION}, found SDK ${sdk.version} and CLI ${cli.version}`
    );
  }

  const packageRoot = dirname(cli.packageJsonPath);
  const binary =
    process.platform === 'win32'
      ? join(packageRoot, 'bin', 'opencode.exe')
      : join(packageRoot, 'bin', '.opencode');
  try {
    await access(binary, process.platform === 'win32' ? fsConstants.F_OK : fsConstants.X_OK);
  } catch (error) {
    throw new Error(
      `Packaged OpenCode ${OPENCODE_VERSION} native binary is missing or not executable; reinstall Agor with optional dependencies enabled`,
      { cause: error }
    );
  }
  return binary;
}
