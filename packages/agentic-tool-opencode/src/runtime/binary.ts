import { spawn } from 'node:child_process';
import { constants as fsConstants } from 'node:fs';
import { access } from 'node:fs/promises';
import { delimiter, join } from 'node:path';
import { resolveManagedAgenticToolPackageDirectory } from '@agor/core/agentic-integrations';
import { OPENCODE_VERSION } from '../shared/known-models.js';

async function isExecutable(path: string): Promise<boolean> {
  try {
    await access(path, process.platform === 'win32' ? fsConstants.F_OK : fsConstants.X_OK);
    return true;
  } catch {
    return false;
  }
}

export async function readOpenCodeBinaryVersion(binary: string): Promise<string> {
  return readOpenCodeCommandVersion({ executable: binary, argsPrefix: [] });
}

export type OpenCodeCommand = { executable: string; argsPrefix: readonly string[] };

async function readOpenCodeCommandVersion(command: OpenCodeCommand): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(command.executable, [...command.argsPrefix, '--version'], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let output = '';
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`OpenCode version check timed out for ${command.executable}`));
    }, 5_000);
    child.stdout.on('data', (chunk) => {
      output += String(chunk);
    });
    child.stderr.on('data', (chunk) => {
      output += String(chunk);
    });
    child.once('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once('close', (code) => {
      clearTimeout(timer);
      if (code !== 0) {
        reject(new Error(`OpenCode version check exited with code ${code}`));
        return;
      }
      const version = output.match(/\b\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?\b/)?.[0];
      if (!version) {
        reject(
          new Error(`Could not parse OpenCode version from: ${output.trim() || '(no output)'}`)
        );
        return;
      }
      resolve(version);
    });
  });
}

export async function assertOpenCodeBinaryCompatibility(binary: string): Promise<string> {
  return assertOpenCodeCommandCompatibility({ executable: binary, argsPrefix: [] });
}

export async function assertOpenCodeCommandCompatibility(
  command: OpenCodeCommand
): Promise<string> {
  const version = await readOpenCodeCommandVersion(command);
  if (version !== OPENCODE_VERSION) {
    throw new Error(
      `OpenCode CLI ${version} is incompatible with Agor's pinned SDK ${OPENCODE_VERSION}. ` +
        `Install OpenCode ${OPENCODE_VERSION}, or point AGOR_OPENCODE_PATH to that version.`
    );
  }
  return version;
}

/** Use the shipped native package without running opencode-ai's postinstall. */
export function getOpenCodeNativePackageName(
  platform: NodeJS.Platform,
  arch: string,
  musl: boolean
): string {
  if (!['linux', 'darwin', 'win32'].includes(platform) || !['x64', 'arm64'].includes(arch)) {
    throw new Error(`OpenCode does not support ${platform}/${arch}`);
  }
  // The baseline build also works on AVX2 machines, without probing host CPU
  // features or executing platform helpers during a managed runtime lookup.
  return `opencode-${platform === 'win32' ? 'windows' : platform}-${arch}${arch === 'x64' ? '-baseline' : ''}${platform === 'linux' && musl ? '-musl' : ''}`;
}

/** Resolve the user-installed OpenCode CLI without assuming how it was installed. */
export async function resolvePackagedOpenCodeBinary(): Promise<OpenCodeCommand> {
  if (process.env.AGOR_MANAGED_AGENTIC_TOOLS === '1') {
    const agorVersion = process.env.AGOR_VERSION;
    if (!agorVersion) throw new Error('AGOR_VERSION is missing from the packaged Agor runtime');
    try {
      const report = process.report.getReport() as { header?: { glibcVersionRuntime?: string } };
      const nativePackage = getOpenCodeNativePackageName(
        process.platform,
        process.arch,
        process.platform === 'linux' && !report.header?.glibcVersionRuntime
      );
      const packageDirectory = await resolveManagedAgenticToolPackageDirectory(
        'opencode',
        agorVersion,
        nativePackage
      );
      const binary = join(
        packageDirectory,
        'bin',
        process.platform === 'win32' ? 'opencode.exe' : 'opencode'
      );
      if (!(await isExecutable(binary)))
        throw new Error(`managed OpenCode binary is not accessible: ${binary}`);
      const command = { executable: binary, argsPrefix: [] };
      await assertOpenCodeCommandCompatibility(command);
      return command;
    } catch (error) {
      throw new Error(
        `OpenCode support is not usable for Agor ${agorVersion}: ${error instanceof Error ? error.message : String(error)}. Run: agor install`
      );
    }
  }

  const configured = process.env.AGOR_OPENCODE_PATH?.trim();
  if (configured) {
    if (await isExecutable(configured)) {
      await assertOpenCodeBinaryCompatibility(configured);
      return { executable: configured, argsPrefix: [] };
    }
    throw new Error(`AGOR_OPENCODE_PATH is not executable: ${configured}`);
  }

  const names = process.platform === 'win32' ? ['opencode.exe', 'opencode.cmd'] : ['opencode'];
  for (const directory of (process.env.PATH ?? '').split(delimiter).filter(Boolean)) {
    for (const name of names) {
      const candidate = join(directory, name);
      if (await isExecutable(candidate)) {
        await assertOpenCodeBinaryCompatibility(candidate);
        return { executable: candidate, argsPrefix: [] };
      }
    }
  }

  throw new Error(
    `OpenCode ${OPENCODE_VERSION} is not available to the Agor executor. ` +
      'Install the OpenCode CLI using its official instructions, ensure `opencode` is on the daemon PATH, ' +
      'or set AGOR_OPENCODE_PATH. See https://agor.live/guide/extended-install#agentic-tools'
  );
}
