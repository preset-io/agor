import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { scan } from './tree';

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});
it.each([1024, 4 * 1024 * 1024])(
  'bounds in-flight upload count and bytes for %i-byte files',
  async (size) => {
    const root = await mkdtemp(path.join(tmpdir(), 'agor-scan-'));
    roots.push(root);
    await Promise.all(
      Array.from({ length: 40 }, (_, i) => writeFile(path.join(root, `${i}`), Buffer.alloc(size)))
    );
    let active = 0;
    let maximum = 0;
    let bytes = 0;
    let maximumBytes = 0;
    await scan(
      root,
      [],
      { maximumBytes: 256 * 1024 * 1024, maximumFiles: 100 },
      async (_name, _entry, content) => {
        active++;
        bytes += content.length;
        maximum = Math.max(maximum, active);
        maximumBytes = Math.max(maximumBytes, bytes);
        await new Promise((resolve) => setTimeout(resolve, 50));
        active--;
        bytes -= content.length;
      }
    );
    expect(active).toBe(0);
    expect(maximum).toBeLessThanOrEqual(32);
    expect(maximumBytes).toBeLessThanOrEqual(16 * 1024 * 1024);
    if (size === 1024) expect(maximum).toBeGreaterThan(8);
  }
);
it('waits for outstanding uploads and refuses admission after an upload failure', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'agor-scan-'));
  roots.push(root);
  await Promise.all(
    Array.from({ length: 40 }, (_, i) => writeFile(path.join(root, `${i}`), 'file'))
  );
  let active = 0;
  await expect(
    scan(root, [], { maximumBytes: 1000, maximumFiles: 100 }, async (name) => {
      active++;
      await new Promise((resolve) => setTimeout(resolve, 5));
      active--;
      if (name === '0') throw new Error('S3 unavailable');
    })
  ).rejects.toThrow('S3 unavailable');
  expect(active).toBe(0);
});
