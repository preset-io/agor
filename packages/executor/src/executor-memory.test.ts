import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { expect, it } from 'vitest';
import { ExecutorMemorySampler } from './executor-memory.js';

it('observes a real local Node child without reading argv/env and retains sampled peaks', async () => {
  const child = spawn(
    process.execPath,
    [
      '-e',
      'const b = Buffer.alloc(8*1024*1024, 1); process.stdout.write("ready\\n"); setInterval(() => b[0], 1000);',
    ],
    { stdio: ['ignore', 'pipe', 'ignore'] }
  );
  try {
    await once(child.stdout!, 'data');
    const sampler = new ExecutorMemorySampler();
    const first = await sampler.sample();
    expect(first.current.rss).toBeGreaterThan(0);
    expect(first.current.heap_limit).toBeGreaterThan(first.current.heap_used!);
    expect(first.current.external).toBeGreaterThanOrEqual(first.current.array_buffers!);
    if (process.platform === 'linux')
      expect(first.current.direct_children_rss).toBeGreaterThan(8 * 1024 * 1024);
    const second = await sampler.sample();
    expect(second.sampled_peak.rss).toBeGreaterThanOrEqual(first.current.rss!);
    expect(JSON.stringify(first)).not.toContain(String(child.pid));
  } finally {
    child.kill();
    await once(child, 'exit');
  }
});

it('reads bounded cgroup v2/v1 fixtures and omits missing, unlimited and oversized observations', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'executor-memory-'));
  const roots = { proc: path.join(dir, 'proc'), cgroup: path.join(dir, 'cgroup') };
  try {
    await mkdir(path.join(roots.proc, 'self'), { recursive: true });
    await mkdir(path.join(roots.cgroup, 'test'), { recursive: true });
    await writeFile(path.join(roots.proc, 'self/cgroup'), '0::/test\n');
    await writeFile(path.join(roots.cgroup, 'test/memory.current'), '1000\n');
    await writeFile(path.join(roots.cgroup, 'test/memory.max'), 'max\n');
    await writeFile(
      path.join(roots.cgroup, 'test/memory.stat'),
      'anon 600\nfile 300\nkernel 100\n'
    );
    const v2 = await new ExecutorMemorySampler(roots).sample();
    expect(v2.current).toMatchObject({
      cgroup_current: 1000,
      cgroup_anon: 600,
      cgroup_file: 300,
      cgroup_kernel: 100,
    });
    expect(v2.current.cgroup_limit).toBeUndefined();
    expect(v2.current.direct_children_rss).toBeUndefined();
    await writeFile(path.join(roots.cgroup, 'test/memory.stat'), `anon 600\n${'x'.repeat(20_000)}`);
    expect((await new ExecutorMemorySampler(roots).sample()).current.cgroup_anon).toBeUndefined();
    await writeFile(path.join(roots.proc, 'self/cgroup'), '7:memory:/test\n');
    await mkdir(path.join(roots.cgroup, 'memory/test'), { recursive: true });
    await writeFile(path.join(roots.cgroup, 'memory/test/memory.usage_in_bytes'), '2000');
    await writeFile(
      path.join(roots.cgroup, 'memory/test/memory.limit_in_bytes'),
      '9223372036854771712'
    );
    await writeFile(
      path.join(roots.cgroup, 'memory/test/memory.stat'),
      'total_rss 1500\ntotal_cache 500\n'
    );
    const v1 = await new ExecutorMemorySampler(roots).sample();
    expect(v1.current).toMatchObject({ cgroup_current: 2000, cgroup_anon: 1500, cgroup_file: 500 });
    expect(v1.current.cgroup_limit).toBeUndefined();
    expect(v1.current.cgroup_kernel).toBeUndefined();
    await writeFile(path.join(roots.proc, 'self/cgroup'), '0::/../../host');
    expect(
      (await new ExecutorMemorySampler(roots).sample()).current.cgroup_current
    ).toBeUndefined();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
