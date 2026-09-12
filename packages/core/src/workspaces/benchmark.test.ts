/** Opt-in reproducible repository benchmark; never runs in the normal unit suite. */
import { mkdir, mkdtemp, rm, statfs, writeFile } from 'node:fs/promises';
import { cpus, platform, release, tmpdir, totalmem } from 'node:os';
import path from 'node:path';
import { expect, it } from 'vitest';
import type { BranchID, TenantID } from '../types';
import { BranchWorkspaceCoordinator } from './coordinator';
import { LocalWorkspaceBlobs } from './local-blobs';
import type { WorkspaceMetadata, WorkspaceOptions, WorkspaceState } from './types';

it.skipIf(!process.env.AGOR_WORKSPACE_BENCH_SOURCE)(
  'benchmarks local repository replicas',
  async () => {
    const root = await mkdtemp(
      path.join(process.env.AGOR_WORKSPACE_BENCH_ROOT ?? tmpdir(), 'agor-bench-')
    );
    const samples: Array<{
      name: string;
      clone: string;
      ms: number;
      outcome: string;
      detail?: string;
    }> = [];
    const options: WorkspaceOptions = {
      root: path.join(root, 'worker'),
      host: 'bench',
      leaseMs: 3600000,
      toolLeaseMs: 600000,
      clone: 'copy',
      maximumBytes: 2 * 1024 ** 3,
      maximumFiles: 250000,
      minimumFreeBytes: 0,
      minimumFreeInodes: 0,
      maximumActiveTools: 8,
      maximumReceipts: 1000,
      exclude: ['.terraform'],
      observe: (m) => {
        if (m.name.endsWith('_ms'))
          samples.push({ name: m.name, clone: options.clone, ms: m.value, outcome: m.outcome });
      },
    };
    const scope = { tenantId: 'benchmark' as TenantID, branchId: 'benchmark' as BranchID };
    let state: WorkspaceState | null = null;
    const metadata: WorkspaceMetadata = {
      async read() {
        return { state: structuredClone(state), now: Date.now() };
      },
      async mutate<T>(
        work: (s: WorkspaceState | null, now: number) => { state: WorkspaceState; result: T }
      ) {
        const next = work(structuredClone(state), Date.now());
        state = structuredClone(next.state);
        return structuredClone(next.result);
      },
    };
    const blobs = new LocalWorkspaceBlobs(path.join(root, 'objects'), scope.tenantId);
    const measured = async (name: string, work: () => Promise<unknown>) => {
      const start = performance.now();
      try {
        await work();
        samples.push({ name, clone: options.clone, ms: performance.now() - start, outcome: 'ok' });
      } catch (error) {
        samples.push({
          name,
          clone: options.clone,
          ms: performance.now() - start,
          outcome: 'error',
          detail: String(error),
        });
        throw error;
      }
    };
    try {
      const c = new BranchWorkspaceCoordinator(scope, metadata, blobs, options);
      await measured('cold_materialisation', () =>
        c.materialise(process.env.AGOR_WORKSPACE_BENCH_SOURCE)
      );
      for (const clone of ['copy', 'reflink'] as const) {
        options.clone = clone;
        try {
          for (let i = 0; i < 5; i++) {
            const start = performance.now();
            const t = await c.beginTool(
              `warm-${clone}`,
              `warm-${clone}-${i}`,
              `warm-${clone}-${i}`
            );
            samples.push({
              name: i === 0 ? 'fresh_replica' : 'warm_refresh',
              clone,
              ms: performance.now() - start,
              outcome: 'ok',
            });
            await c.completeTool(t.ticket);
          }
        } catch (error) {
          samples.push({
            name: 'clone_probe',
            clone,
            ms: 0,
            outcome: 'error',
            detail: String(error),
          });
          continue;
        }
        for (const count of [1, 100]) {
          const t = await c.beginTool(
            `edit-${clone}`,
            `edit-${clone}-${count}`,
            `edit-${clone}-${count}`
          );
          for (let i = 0; i < count; i++)
            await writeFile(path.join(t.workspace, `benchmark-${i}.txt`), `${clone}-${i}`);
          await measured(`publish_${count}_files`, () => c.completeTool(t.ticket));
        }
        const t = await c.beginTool(
          `generated-${clone}`,
          `generated-${clone}`,
          `generated-${clone}`
        );
        await mkdir(path.join(t.workspace, 'dist'), { recursive: true });
        await writeFile(path.join(t.workspace, 'dist/ignored'), Buffer.alloc(64 * 1024 * 1024));
        await measured('excluded_64MiB', () => c.completeTool(t.ticket));
        for (const count of [2, 4, 8])
          await measured(`concurrent_${count}`, async () => {
            const tools = await Promise.all(
              Array.from({ length: count }, (_, i) =>
                c.beginTool(`e${i}`, `${clone}-${count}-${i}`, `${clone}-${count}-${i}`)
              )
            );
            await Promise.all(
              tools.map(async (tool, i) => {
                await writeFile(path.join(tool.workspace, `concurrent-${i}`), `${clone}-${count}`);
                expect((await c.completeTool(tool.ticket)).status).toBe('committed');
              })
            );
          });
      }
      options.clone = 'copy';
      await measured('four_branches_small_fixture', async () => {
        const source = path.join(root, 'multi-source');
        await mkdir(source);
        await writeFile(path.join(source, 'source.txt'), 'base');
        await Promise.all(
          Array.from({ length: 4 }, async (_, i) => {
            let branchState: WorkspaceState | null = null;
            const store: WorkspaceMetadata = {
              async read() {
                return { state: structuredClone(branchState), now: Date.now() };
              },
              async mutate<T>(
                work: (
                  s: WorkspaceState | null,
                  now: number
                ) => { state: WorkspaceState; result: T }
              ) {
                const next = work(structuredClone(branchState), Date.now());
                branchState = structuredClone(next.state);
                return structuredClone(next.result);
              },
            };
            const branch = new BranchWorkspaceCoordinator(
              { ...scope, branchId: `multi-${i}` as BranchID },
              store,
              blobs,
              options
            );
            await branch.materialise(source);
            const tool = await branch.beginTool('executor', 'tool', 'key');
            await writeFile(path.join(tool.workspace, 'source.txt'), `branch-${i}`);
            expect((await branch.completeTool(tool.ticket)).status).toBe('committed');
            await branch.checkpoint();
          })
        );
      });
      await measured('checkpoint', () => c.checkpoint());
      await measured('warm_activation', () => c.materialise());
      await c.drain();
      const other = new BranchWorkspaceCoordinator(scope, metadata, blobs, {
        ...options,
        root: path.join(root, 'other-host'),
        host: 'other-host',
      });
      await measured('cold_restore', () => other.restore());
      expect((await metadata.read()).state?.host).toBe('other-host');
    } finally {
      const filesystem = await statfs(root);
      const groups = [...new Set(samples.map((s) => `${s.clone}/${s.name}`))].map((key) => {
        const values = samples
          .filter((s) => `${s.clone}/${s.name}` === key && s.outcome === 'ok')
          .map((s) => s.ms)
          .sort((a, b) => a - b);
        return {
          key,
          count: values.length,
          p50_ms: values[Math.floor(values.length / 2)] ?? null,
          p95_ms: values[Math.ceil(values.length * 0.95) - 1] ?? null,
        };
      });
      const output = {
        schema: 1,
        createdAt: new Date().toISOString(),
        environment: {
          platform: platform(),
          release: release(),
          cpu: cpus()[0]?.model,
          cores: cpus().length,
          memoryBytes: totalmem(),
          filesystemType: filesystem.type,
          storageClass: 'local-unverified-not-NVMe-certified',
        },
        metadata: 'in-memory serialized authority; commit timing excludes production SQL and S3',
        source: process.env.AGOR_WORKSPACE_BENCH_SOURCE,
        samples,
        groups,
        commandBenchmarks:
          'Use scripts/benchmark-workspace-commands.mjs on the same NVMe host for paired install/typecheck/build trials',
      };
      await writeFile(
        process.env.AGOR_WORKSPACE_BENCH_OUTPUT ??
          path.join(tmpdir(), 'agor-workspace-benchmark.json'),
        JSON.stringify(output, null, 2)
      );
      console.log(JSON.stringify(groups));
      await rm(root, { recursive: true, force: true });
    }
  },
  600000
);
