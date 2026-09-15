/** Test-only cross-repository driver. The caller materializes the reviewed fixture commit. */
import { type ChildProcessWithoutNullStreams, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { MANAGED_MCP_OAUTH_CONTRACT_SOURCE_SHA256 } from '@agor/core/config';

const MAX_FRAME_BYTES = 2 * 1024 * 1024;
type Method = 'start' | 'seed' | 'setRuntimeUpstream' | 'request' | 'counters' | 'stop';

/** No shell, no provider credentials, no fallback to a deployed broker. */
export async function startPairedCloudProcess(sourceDirectory: string) {
  const contract = await readFile(
    resolve(sourceDirectory, 'packages/contracts/src/mcp-oauth-v1.ts')
  );
  if (
    createHash('sha256').update(contract).digest('hex') !== MANAGED_MCP_OAUTH_CONTRACT_SOURCE_SHA256
  )
    throw new Error('Paired Cloud contract differs from the runtime source pin');
  const child = spawn(
    'pnpm',
    [
      '--filter',
      '@agor-cloud/mcp-oauth-worker',
      'exec',
      'tsx',
      'src/test-support/pairedFixtureCli.ts',
    ],
    {
      cwd: sourceDirectory,
      stdio: 'pipe',
      // The paired fixture generates all credentials; never inherit provider/database tokens.
      env: {
        PATH: process.env.PATH,
        HOME: process.env.HOME,
        TMPDIR: process.env.TMPDIR,
        CI: '1',
        NODE_ENV: 'test',
      },
    }
  );
  return createPairedCloudChannel(child);
}

/** Exported separately so framing, failure and cancellation can be tested without Docker. */
export function createPairedCloudChannel(child: ChildProcessWithoutNullStreams) {
  let sequence = 0;
  let pendingBytes = Buffer.alloc(0);
  let failed = false;
  const pending = new Map<
    string,
    {
      resolve: (value: unknown) => void;
      reject: (error: Error) => void;
      timer: ReturnType<typeof setTimeout>;
    }
  >();
  const fail = () => {
    failed = true;
    pendingBytes = Buffer.alloc(0);
    for (const item of pending.values()) {
      clearTimeout(item.timer);
      item.reject(new Error('Paired fixture transport unavailable'));
    }
    pending.clear();
  };
  // Drain without logging: provider response bodies and browser correlation never enter test logs.
  child.stderr.resume();
  child.once('error', fail);
  child.once('exit', fail);
  child.stdin.on('error', fail);
  child.stdout.on('error', fail);
  child.stderr.on('error', fail);
  child.stdout.on('data', (chunk: Buffer) => {
    if (failed) return;
    pendingBytes = Buffer.concat([pendingBytes, chunk]);
    while (!failed) {
      const boundary = pendingBytes.indexOf(10);
      if (boundary < 0) {
        if (pendingBytes.length > MAX_FRAME_BYTES) {
          fail();
          child.kill();
        }
        return;
      }
      if (boundary > MAX_FRAME_BYTES) {
        fail();
        child.kill();
        return;
      }
      const frame = pendingBytes.subarray(0, boundary);
      pendingBytes = pendingBytes.subarray(boundary + 1);
      try {
        const reply = JSON.parse(frame.toString('utf8')) as Record<string, unknown>;
        if (typeof reply.id !== 'string' || typeof reply.ok !== 'boolean') throw new Error();
        const item = pending.get(reply.id);
        if (!item) throw new Error();
        pending.delete(reply.id);
        clearTimeout(item.timer);
        if (reply.ok) item.resolve(reply.result);
        else item.reject(new Error('Paired fixture operation rejected'));
      } catch {
        fail();
        child.kill();
      }
    }
  });
  const call = (method: Method, params?: unknown, timeoutMs = 120000): Promise<unknown> => {
    if (failed) return Promise.reject(new Error('Paired fixture transport unavailable'));
    const id = String(++sequence);
    const encoded = Buffer.from(
      `${JSON.stringify({ id, method, ...(params === undefined ? {} : { params }) })}\n`
    );
    if (encoded.length > MAX_FRAME_BYTES)
      return Promise.reject(new Error('Paired fixture request exceeds bound'));
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        fail();
        child.kill();
      }, timeoutMs);
      pending.set(id, { resolve, reject, timer });
      child.stdin.write(encoded, (error) => {
        if (error) fail();
      });
    });
  };
  return {
    call,
    async stop() {
      try {
        if (!failed) await call('stop', undefined, 10000);
      } finally {
        fail();
        child.stdin.end();
        child.kill();
      }
    },
  };
}
