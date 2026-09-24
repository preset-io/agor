import { open } from 'node:fs/promises';
import path from 'node:path';
import { getHeapStatistics } from 'node:v8';
import {
  EXECUTOR_MEMORY_FIELDS,
  type ExecutorMemorySample,
  type ExecutorMemoryValues,
} from '@agor/core/types';

/** Proc/cgroup pseudo-files have no reliable stat size. Never read them unbounded. */
async function readBounded(
  filename: string,
  limit = 16 * 1024,
  prefix = false
): Promise<string | undefined> {
  const file = await open(filename, 'r').catch(() => undefined);
  if (!file) return undefined;
  try {
    const buffer = Buffer.alloc(limit + 1);
    const { bytesRead } = await file.read(buffer, 0, buffer.length, 0);
    return prefix || bytesRead <= limit ? buffer.toString('utf8', 0, bytesRead) : undefined;
  } catch {
    return undefined;
  } finally {
    await file.close();
  }
}

function bytes(value: string | undefined): number | undefined {
  if (!value || !/^\d+$/.test(value.trim())) return undefined;
  const number = Number(value);
  return Number.isSafeInteger(number) && number >= 0 ? number : undefined;
}

/** Only the executor's own cgroup and direct children; never enumerate the host's processes. */
export class ExecutorMemorySampler {
  private readonly peaks: ExecutorMemoryValues = {};

  constructor(private readonly roots = { proc: '/proc', cgroup: '/sys/fs/cgroup' }) {}

  async sample(): Promise<ExecutorMemorySample> {
    const usage = process.memoryUsage();
    const current: ExecutorMemoryValues = {
      rss: usage.rss,
      heap_used: usage.heapUsed,
      heap_total: usage.heapTotal,
      heap_limit: getHeapStatistics().heap_size_limit,
      external: usage.external,
      // arrayBuffers is already included in external; never sum them.
      ...(usage.arrayBuffers === undefined ? {} : { array_buffers: usage.arrayBuffers }),
    };
    await Promise.all([this.readCgroup(current), this.readChildren(current)]);
    for (const field of EXECUTOR_MEMORY_FIELDS) {
      const value = current[field];
      if (value !== undefined) this.peaks[field] = Math.max(this.peaks[field] ?? value, value);
    }
    return { current, sampled_peak: { ...this.peaks } };
  }

  private async readChildren(current: ExecutorMemoryValues): Promise<void> {
    const list = await readBounded(
      path.join(this.roots.proc, `self/task/${process.pid}/children`),
      4096
    );
    if (list === undefined || !/^[\d\s]*$/.test(list)) return;
    const children = list.trim() ? list.trim().split(/\s+/) : [];
    // A partial aggregate would look like a falsely small process tree.
    if (children.length > 32) return;
    let total = 0;
    for (const pid of children) {
      const status = await readBounded(path.join(this.roots.proc, pid, 'status'), 64 * 1024, true);
      if (bytes(status?.match(/^PPid:\s+(\d+)$/m)?.[1]) !== process.pid) return;
      const rss = bytes(status?.match(/^VmRSS:\s+(\d+) kB$/m)?.[1]);
      if (rss === undefined) return; // exit/race/unsupported is not zero
      total += rss * 1024;
    }
    current.direct_children_rss = total;
  }

  private async readCgroup(current: ExecutorMemoryValues): Promise<void> {
    const membership = await readBounded(path.join(this.roots.proc, 'self/cgroup'));
    const v2 = membership?.split('\n').find((line) => line.startsWith('0::'));
    const v1 = membership
      ?.split('\n')
      .find((line) => line.split(':')[1]?.split(',').includes('memory'));
    const entry = v2 ?? v1;
    if (!entry) return;
    const memberPath = entry.slice(entry.indexOf(':', entry.indexOf(':') + 1) + 1);
    // Non-namespaced/custom mounts we cannot resolve are omitted, never replaced
    // by host/root usage. No arbitrary path supplied by a task is accepted.
    if (!memberPath.startsWith('/') || memberPath.split('/').includes('..')) return;
    const root = path.join(this.roots.cgroup, ...(v2 ? [] : ['memory']), memberPath);
    const [used, limit, stat] = await Promise.all([
      readBounded(path.join(root, v2 ? 'memory.current' : 'memory.usage_in_bytes')),
      readBounded(path.join(root, v2 ? 'memory.max' : 'memory.limit_in_bytes')),
      readBounded(path.join(root, 'memory.stat')),
    ]);
    const put = (key: keyof ExecutorMemoryValues, value: string | undefined) => {
      const number = bytes(value);
      if (number !== undefined) current[key] = number;
    };
    put('cgroup_current', used);
    put('cgroup_limit', limit); // v2 "max" / v1 unlimited sentinel are omitted
    const values = new Map(
      stat
        ?.trim()
        .split('\n')
        .map((line) => line.trim().split(/\s+/) as [string, string])
    );
    put('cgroup_anon', values.get(v2 ? 'anon' : 'total_rss'));
    put('cgroup_file', values.get(v2 ? 'file' : 'total_cache'));
    if (v2) put('cgroup_kernel', values.get('kernel'));
  }
}
