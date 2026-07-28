import { type ChildProcess, spawn } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { terminateProcessTree } from './process-tree.js';

const spawnedGroups: ChildProcess[] = [];
const tempPaths: string[] = [];

function processExists(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error instanceof Error && 'code' in error && error.code !== 'ESRCH';
  }
}

async function waitForFile(filePath: string, timeoutMs = 2_000): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      return await readFile(filePath, 'utf8');
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }
  throw new Error(`Timed out waiting for ${filePath}`);
}

afterEach(async () => {
  if (process.platform !== 'win32') {
    for (const child of spawnedGroups) {
      if (!child.pid) continue;
      try {
        process.kill(-child.pid, 'SIGKILL');
      } catch {
        // Already gone.
      }
    }
  }
  spawnedGroups.length = 0;
  await Promise.all(
    tempPaths.splice(0).map((tempPath) => rm(tempPath, { recursive: true, force: true }))
  );
});

describe.skipIf(process.platform === 'win32')('terminateProcessTree', () => {
  it('terminates and awaits a stubborn grandchild in the executor process group', async () => {
    const tempPath = await mkdtemp(path.join(tmpdir(), 'agor-process-tree-'));
    tempPaths.push(tempPath);
    const grandchildPidPath = path.join(tempPath, 'grandchild.pid');

    const grandchildCode = [
      "process.on('SIGTERM', () => {});",
      "process.on('SIGINT', () => {});",
      'setInterval(() => {}, 1_000);',
    ].join('');
    const parentCode = [
      "const { spawn } = require('node:child_process');",
      "const { writeFileSync } = require('node:fs');",
      `const child = spawn(process.execPath, ['-e', ${JSON.stringify(grandchildCode)}], { stdio: 'ignore' });`,
      `writeFileSync(${JSON.stringify(grandchildPidPath)}, String(child.pid));`,
      "process.on('SIGTERM', () => {});",
      "process.on('SIGINT', () => {});",
      'setInterval(() => {}, 1_000);',
    ].join('');

    const parent = spawn(process.execPath, ['-e', parentCode], {
      detached: true,
      stdio: 'ignore',
    });
    spawnedGroups.push(parent);

    const grandchildPid = Number(await waitForFile(grandchildPidPath));
    expect(parent.pid).toBeTypeOf('number');
    expect(processExists(grandchildPid)).toBe(true);

    await terminateProcessTree(parent, {
      detachedProcessGroup: true,
      graceMs: 30,
      forceKillWaitMs: 2_000,
    });

    expect(parent.pid ? processExists(parent.pid) : false).toBe(false);
    expect(processExists(grandchildPid)).toBe(false);
  });
});
