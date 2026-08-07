import { spawn } from 'node:child_process';
import { access } from 'node:fs/promises';
import { delimiter, isAbsolute, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { assertOpenCodeBinaryCompatibility } from '@agor/agentic-tool-opencode/runtime';

export type AgenticToolDiagnostic = {
  id: string;
  name: string;
  kind: 'executable' | 'package';
  status: 'ready' | 'missing' | 'unusable';
  path?: string;
  version?: string;
  detail?: string;
  docsUrl: string;
};

const DOCS_BASE = 'https://agor.live/guide/extended-install';
const EXECUTABLES = [
  { id: 'claude-code', name: 'Claude Code', commands: ['claude'] },
  { id: 'codex', name: 'Codex', commands: ['codex'] },
  { id: 'opencode', name: 'OpenCode', commands: ['opencode'] },
] as const;

const PACKAGES = [
  { id: 'copilot', name: 'GitHub Copilot', packageName: '@github/copilot-sdk' },
  { id: 'gemini', name: 'Gemini', packageName: '@google/gemini-cli-core' },
  { id: 'cursor', name: 'Cursor SDK', packageName: '@cursor/sdk' },
] as const;

async function findExecutable(command: string, pathValue = process.env.PATH ?? '') {
  const extensions =
    process.platform === 'win32' ? (process.env.PATHEXT ?? '.EXE;.CMD;.BAT').split(';') : [''];
  for (const directory of pathValue.split(delimiter).filter(Boolean)) {
    for (const extension of extensions) {
      const candidate = join(directory, `${command}${extension.toLowerCase()}`);
      try {
        await access(candidate);
        return candidate;
      } catch {
        // Continue searching PATH.
      }
    }
  }
  return undefined;
}

async function readVersion(executable: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, ['--version'], { stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '';
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error('version check timed out'));
    }, 5000);
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
      if (code !== 0) reject(new Error(`version check exited with code ${code}`));
      else resolve(output.trim().split(/\r?\n/, 1)[0] || 'version unknown');
    });
  });
}

async function diagnoseExecutable(
  tool: (typeof EXECUTABLES)[number]
): Promise<AgenticToolDiagnostic> {
  const executable = await findExecutable(tool.commands[0]);
  if (!executable) {
    return {
      id: tool.id,
      name: tool.name,
      kind: 'executable',
      status: 'missing',
      docsUrl: DOCS_BASE,
    };
  }
  try {
    const version =
      tool.id === 'opencode'
        ? await assertOpenCodeBinaryCompatibility(executable)
        : await readVersion(executable);
    return {
      id: tool.id,
      name: tool.name,
      kind: 'executable',
      status: 'ready',
      path: isAbsolute(executable) ? executable : undefined,
      version,
      docsUrl: DOCS_BASE,
    };
  } catch (error) {
    return {
      id: tool.id,
      name: tool.name,
      kind: 'executable',
      status: 'unusable',
      path: executable,
      detail: error instanceof Error ? error.message : String(error),
      docsUrl: DOCS_BASE,
    };
  }
}

async function diagnosePackage(tool: (typeof PACKAGES)[number]): Promise<AgenticToolDiagnostic> {
  try {
    const packageJson = import.meta.resolve(tool.packageName);
    return {
      id: tool.id,
      name: tool.name,
      kind: 'package',
      status: 'ready',
      path: packageJson.startsWith('file:') ? fileURLToPath(packageJson) : packageJson,
      docsUrl: DOCS_BASE,
    };
  } catch {
    return { id: tool.id, name: tool.name, kind: 'package', status: 'missing', docsUrl: DOCS_BASE };
  }
}

export async function diagnoseAgenticTools(): Promise<AgenticToolDiagnostic[]> {
  return Promise.all([...EXECUTABLES.map(diagnoseExecutable), ...PACKAGES.map(diagnosePackage)]);
}
