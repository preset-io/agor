import { randomUUID } from 'node:crypto';
import { lstat, mkdir, readFile, rename, rm, statfs, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { getManagedStorageSegments } from '../config/storage-layout';
import { traceBestEffort } from '../tracing/datadog';
import { evictLocalWorkspace } from './local-eviction';
import { applyWorkspaceMutations } from './revisions';
import {
  equal,
  hash,
  mutations,
  preserveLocalPaths,
  refresh,
  render,
  repositoryPaths,
  scan,
  validateTree,
} from './tree';
import type {
  CommitOutcome,
  Mutation,
  ToolTicket,
  Tree,
  WorkspaceBlobs,
  WorkspaceMetadata,
  WorkspaceOptions,
  WorkspaceScope,
  WorkspaceState,
} from './types';
import { WorkspaceError } from './types';

/** Only the worker controller calls this API. SDKs receive replica paths, never its authority. */
export class BranchWorkspaceCoordinator {
  readonly directory: string;
  private readonly locks = new Set<string>();
  constructor(
    readonly scope: WorkspaceScope,
    readonly metadata: WorkspaceMetadata,
    readonly blobs: WorkspaceBlobs,
    readonly options: WorkspaceOptions
  ) {
    if (!/^[A-Za-z0-9_-]+$/.test(scope.branchId))
      throw new WorkspaceError('INVALID', 'Invalid branch id');
    this.directory = path.join(
      options.root,
      ...getManagedStorageSegments('branches', { tenantId: scope.tenantId, tenantSeparated: true }),
      scope.branchId
    );
  }
  private event(
    name: string,
    value: number,
    outcome: 'ok' | 'error' | 'conflict' = 'ok',
    extra: Record<string, unknown> = {}
  ) {
    try {
      this.options.observe?.(
        { name, value, outcome },
        { ...this.scope, host: this.options.host, ...extra }
      );
    } catch {
      /* Telemetry must not affect correctness. */
    }
  }
  private async measured<T>(name: string, work: () => Promise<T>): Promise<T> {
    const start = performance.now();
    try {
      const result = await traceBestEffort(
        this.options.tracer ?? null,
        `workspace.${name}`,
        { ...this.scope, host: this.options.host },
        work
      );
      this.event(name, performance.now() - start);
      return result;
    } catch (error) {
      this.event(name, performance.now() - start, 'error');
      throw error;
    }
  }
  private requireScope(state: WorkspaceState | null): WorkspaceState {
    if (
      !state ||
      state.scope.tenantId !== this.scope.tenantId ||
      state.scope.branchId !== this.scope.branchId ||
      state.schema !== 1
    )
      throw new WorkspaceError('INVALID', 'Workspace not found');
    return state;
  }
  private owned(state: WorkspaceState | null, now: number, epoch?: number): WorkspaceState {
    const s = this.requireScope(state);
    if (s.maintenance) throw new WorkspaceError('BUSY', 'Workspace maintenance is active');
    if (
      s.host !== this.options.host ||
      s.leaseUntil <= now ||
      (epoch !== undefined && s.epoch !== epoch)
    ) {
      this.event('fencing_failure', 1, 'error');
      throw new WorkspaceError('FENCED', 'Branch placement lease is no longer owned');
    }
    return s;
  }
  private reap(s: WorkspaceState, now: number) {
    for (const [key, ticket] of Object.entries(s.active))
      if (ticket.expiresAt <= now) {
        delete s.active[key];
        this.event(s.receipts[key] ? 'unfinished_local_cleanup' : 'abandoned_tool', 1, 'error', {
          executorId: ticket.executorId,
          toolId: ticket.toolId,
        });
      }
  }
  async capacity(expectedBytes = 0, expectedFiles = 0): Promise<void> {
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    const fs = await statfs(this.directory);
    if (
      process.platform === 'linux' &&
      ![0x58465342, 0xef53, 0x9123683e, 0x01021994, 0x794c7630].includes(fs.type >>> 0)
    )
      throw new WorkspaceError(
        'UNSUPPORTED',
        'Workspace root must use local XFS, ext4, Btrfs or tmpfs'
      );
    const free = fs.bavail * fs.bsize;
    this.event('disk_free_bytes', free);
    this.event('inodes_free', fs.ffree);
    if (
      free < this.options.minimumFreeBytes + expectedBytes ||
      fs.ffree < this.options.minimumFreeInodes + expectedFiles
    )
      throw new WorkspaceError('CAPACITY', 'Insufficient local bytes or inodes');
  }
  /** Initial import must run with legacy writers stopped. All later activations use durable metadata. */
  async materialise(source?: string, signal?: AbortSignal): Promise<number> {
    return this.measured('materialise_ms', async () => {
      signal?.throwIfAborted();
      await this.capacity();
      let initial: Tree | undefined;
      if (!(await this.metadata.read()).state) {
        if (!source) throw new WorkspaceError('INVALID', 'Initial workspace source required');
        initial = (
          await scan(
            source,
            this.options.exclude,
            this.options,
            async (_name, entry, bytes) => this.blobs.put(entry.hash, bytes),
            signal
          )
        ).tree;
      }
      signal?.throwIfAborted();
      const state = await this.metadata.mutate((existing, now) => {
        const s: WorkspaceState = existing
          ? this.requireScope(existing)
          : {
              schema: 1,
              scope: this.scope,
              revision: 0,
              epoch: 0,
              host: null,
              leaseUntil: 0,
              tree: initial!,
              versions: {},
              active: {},
              receipts: {},
              updatedAt: now,
            };
        if (!s.tree) throw new WorkspaceError('INVALID', 'Initial materialisation lost');
        if (s.maintenance && s.leaseUntil > now)
          throw new WorkspaceError('BUSY', 'Workspace maintenance is active');
        if (s.host && s.host !== this.options.host && s.leaseUntil > now)
          throw new WorkspaceError('BUSY', `Branch affinity requires host ${s.host}`);
        if (s.host !== this.options.host || s.leaseUntil <= now) {
          // Expired hosts are fenced even if their tools are still physically running.
          for (const t of Object.values(s.active))
            this.event('abandoned_tool', 1, 'error', { toolId: t.toolId });
          s.epoch++;
          delete s.maintenance;
          s.active = {};
        }
        s.host = this.options.host;
        s.leaseUntil = now + this.options.leaseMs;
        return { state: s, result: s };
      });
      let renewalError: unknown;
      const renewal = setInterval(
        () => {
          void this.renew().catch((error) => {
            renewalError = error;
          });
        },
        Math.max(10, Math.floor(this.options.leaseMs / 3))
      );
      try {
        await this.base(state, signal);
        if (renewalError) throw renewalError;
        signal?.throwIfAborted();
        await this.renew();
        return state.revision;
      } finally {
        clearInterval(renewal);
      }
    });
  }
  async reapExpiredTools(): Promise<void> {
    await this.metadata.mutate((raw, now) => {
      const s = this.owned(raw, now);
      this.reap(s, now);
      return { state: s, result: undefined };
    });
  }
  async renew(): Promise<void> {
    await this.metadata.mutate((state, now) => {
      const s = this.owned(state, now);
      s.leaseUntil = now + this.options.leaseMs;
      return { state: s, result: undefined };
    });
  }
  private async base(s: WorkspaceState, signal?: AbortSignal): Promise<string> {
    const dir = path.join(this.directory, 'base');
    await mkdir(dir, { recursive: true, mode: 0o700 });
    // PostgreSQL JSONB reorders object keys. Cache identity must survive a SQL round trip.
    const identity = Object.keys(s.tree)
      .sort()
      .map((name) => {
        const e = s.tree[name];
        return [name, e.kind, e.hash, e.mode, e.size, e.target ?? null];
      });
    const target = path.join(dir, `${s.epoch}-${hash(JSON.stringify(identity))}`);
    try {
      if ((await lstat(target)).isDirectory()) return target;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
    }
    const temp = `${target}.${randomUUID()}`;
    await this.capacity(
      Object.values(s.tree).reduce((n, e) => n + e.size, 0),
      Object.keys(s.tree).length
    );
    try {
      await render(temp, s.tree, this.blobs, this.options.exclude, undefined, 'copy', signal);
      try {
        await rename(temp, target);
      } catch (e) {
        if (!['EEXIST', 'ENOTEMPTY'].includes((e as NodeJS.ErrnoException).code ?? '')) throw e;
      }
      return target;
    } finally {
      await rm(temp, { recursive: true, force: true });
    }
  }
  replicaPath(executorId: string): string {
    if (!/^[A-Za-z0-9_-]{1,128}$/.test(executorId))
      throw new WorkspaceError('INVALID', 'Invalid executor id');
    return path.join(this.directory, 'replicas', executorId, 'workspace');
  }
  /** Reservation is durable before rendering. No caller receives a partially built replica. */
  async beginTool(
    executorId: string,
    toolId: string,
    idempotencyKey: string,
    signal?: AbortSignal
  ): Promise<{ ticket: ToolTicket; workspace: string }> {
    return this.measured('replica_refresh_ms', async () => {
      signal?.throwIfAborted();
      const workspace = this.replicaPath(executorId);
      if (!toolId || !idempotencyKey) throw new WorkspaceError('INVALID', 'Tool identity required');
      const key = hash(idempotencyKey);
      const { ticket, state } = await this.metadata.mutate((raw, now) => {
        const s = this.owned(raw, now);
        this.reap(s, now);
        if (s.retiredExecutors?.[executorId])
          throw new WorkspaceError('FENCED', 'Executor was released; allocate a new executor id');
        if (s.receipts[key] || s.active[key])
          throw new WorkspaceError('INVALID', 'Idempotency key already used; query its receipt');
        if (Object.values(s.active).some((t) => t.executorId === executorId))
          throw new WorkspaceError('BUSY', 'Executor already has a tool running');
        if (
          Object.keys(s.active).length >= this.options.maximumActiveTools ||
          Object.keys(s.receipts).length >= this.options.maximumReceipts
        )
          throw new WorkspaceError(
            'CAPACITY',
            'Workspace concurrency or receipt retention budget reached'
          );
        const ticket = {
          executorId,
          toolId,
          key,
          baseRevision: s.revision,
          epoch: s.epoch,
          startedAt: now,
          expiresAt: now + this.options.toolLeaseMs,
        };
        s.active[key] = ticket;
        s.updatedAt = now;
        return { state: s, result: { ticket, state: s } };
      });
      try {
        await mkdir(path.dirname(workspace), { recursive: true, mode: 0o700 });
        const replicaState = path.join(path.dirname(workspace), 'replica-tree.json');
        let previous: Tree | undefined;
        try {
          previous = JSON.parse(await readFile(replicaState, 'utf8')) as Tree;
        } catch (e) {
          if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
        }
        // Removing this admission marker precedes every mutation or tool invocation.
        // A crash leaves it absent; the next begin rebuilds a complete private tree.
        await rm(replicaState, { force: true });
        if (previous) {
          await refresh(workspace, previous, state.tree, this.blobs, this.options.exclude);
        } else {
          const base = await this.base(state, signal);
          const staging = `${workspace}.${randomUUID()}`;
          try {
            await render(
              staging,
              state.tree,
              this.blobs,
              this.options.exclude,
              base,
              this.options.clone,
              signal
            );
            // Keep nested dependencies, build products and private Git metadata.
            await preserveLocalPaths(workspace, staging, this.options.exclude, state.tree);
            await rm(workspace, { recursive: true, force: true });
            await rename(staging, workspace);
            await writeFile(
              path.join(path.dirname(workspace), 'baseline.json'),
              JSON.stringify({ ticket, tree: state.tree }),
              { mode: 0o600 }
            );
          } finally {
            await rm(staging, { recursive: true, force: true });
          }
        }
        await writeFile(
          path.join(path.dirname(workspace), 'baseline.json'),
          JSON.stringify({ ticket, tree: state.tree }),
          { mode: 0o600 }
        );
        signal?.throwIfAborted();
        // Rendering may outlive a lease or race migration. Recheck before returning a runnable path.
        await this.metadata.mutate((raw, now) => {
          const s = this.owned(raw, now, ticket.epoch);
          if (!s.active[key] || ticket.expiresAt <= now)
            throw new WorkspaceError('FENCED', 'Tool reservation expired');
          return { state: s, result: undefined };
        });
        this.event('tool_base_revision', ticket.baseRevision, 'ok', { executorId, toolId });
        return { ticket, workspace };
      } catch (error) {
        await this.abortTool(ticket).catch(() => {});
        throw error;
      }
    });
  }
  async receipt(idempotencyKey: string): Promise<CommitOutcome | undefined> {
    return this.requireScope((await this.metadata.read()).state).receipts[hash(idempotencyKey)]
      ?.outcome;
  }
  async completeTool(ticket: ToolTicket): Promise<CommitOutcome> {
    if (this.locks.has(ticket.executorId))
      throw new WorkspaceError('BUSY', 'Replica completion already running');
    this.locks.add(ticket.executorId);
    try {
      const existing = this.requireScope((await this.metadata.read()).state).receipts[ticket.key];
      if (existing) {
        this.sameTicket(existing.ticket, ticket);
        await this.finishTool(ticket);
        return existing.outcome;
      }
      const workspace = this.replicaPath(ticket.executorId);
      const baseline = JSON.parse(
        await readFile(path.join(path.dirname(workspace), 'baseline.json'), 'utf8')
      ) as { ticket: ToolTicket; tree: Tree };
      this.sameTicket(baseline.ticket, ticket);
      const extracted = await this.measured('mutation_extract_ms', () =>
        scan(
          workspace,
          this.options.exclude,
          this.options,
          async (name, entry, bytes) => {
            if (!equal(baseline.tree[name], entry)) await this.blobs.put(entry.hash, bytes);
          },
          undefined,
          repositoryPaths(baseline.tree)
        )
      );
      const changes = mutations(baseline.tree, extracted.tree);
      this.event('excluded_paths', extracted.excluded);
      this.event('mutation_files', changes.length);
      this.event(
        'mutation_bytes',
        changes.reduce((n, c) => n + (c.after?.size ?? 0), 0)
      );
      const result = await this.commit(ticket, changes);
      const marker = path.join(path.dirname(workspace), 'replica-tree.json');
      const tempMarker = `${marker}.${randomUUID()}`;
      await writeFile(tempMarker, JSON.stringify(extracted.tree), { flag: 'wx', mode: 0o600 });
      await rename(tempMarker, marker);
      await this.finishTool(ticket);
      return result;
    } finally {
      this.locks.delete(ticket.executorId);
    }
  }
  private sameTicket(a: ToolTicket, b: ToolTicket) {
    if (
      (
        ['executorId', 'toolId', 'key', 'baseRevision', 'epoch', 'startedAt', 'expiresAt'] as const
      ).some((key) => a[key] !== b[key])
    )
      throw new WorkspaceError('INVALID', 'Tool ticket mismatch');
  }
  private async commit(ticket: ToolTicket, changes: Mutation[]): Promise<CommitOutcome> {
    return this.measured('commit_ms', () =>
      this.metadata.mutate((raw, now) => {
        const s = this.requireScope(raw);
        const receipt = s.receipts[ticket.key];
        if (receipt) {
          this.sameTicket(receipt.ticket, ticket);
          return { state: s, result: receipt.outcome };
        }
        this.owned(s, now, ticket.epoch);
        const active = s.active[ticket.key];
        if (!active || active.expiresAt <= now)
          throw new WorkspaceError('FENCED', 'Tool lease expired or replaced');
        this.sameTicket(active, ticket);
        const outcome = applyWorkspaceMutations(s, ticket, changes, this.options.exclude);
        if (outcome.status === 'conflict')
          this.event('conflicts', outcome.paths.length, 'conflict');
        s.receipts[ticket.key] = { ticket, completedAt: now, mutations: changes, outcome };
        s.updatedAt = now;
        return { state: s, result: outcome };
      })
    );
  }
  private async finishTool(ticket: ToolTicket): Promise<void> {
    await this.metadata.mutate((raw) => {
      const s = this.requireScope(raw);
      const active = s.active[ticket.key];
      if (active && s.epoch === ticket.epoch) {
        this.sameTicket(active, ticket);
        delete s.active[ticket.key];
      }
      return { state: s, result: undefined };
    });
  }
  async abortTool(ticket: ToolTicket): Promise<void> {
    await this.metadata.mutate((raw, now) => {
      const s = this.owned(raw, now, ticket.epoch);
      const active = s.active[ticket.key];
      if (active) {
        this.sameTicket(active, ticket);
        delete s.active[ticket.key];
        this.event('abandoned_tool', 1, 'error', { toolId: ticket.toolId });
      }
      return { state: s, result: undefined };
    });
  }
  async releaseReplica(executorId: string): Promise<void> {
    const replica = this.replicaPath(executorId);
    await this.metadata.mutate((raw, now) => {
      const s = this.owned(raw, now);
      if (Object.values(s.active).some((t) => t.executorId === executorId))
        throw new WorkspaceError('BUSY', 'Cannot release active replica');
      s.retiredExecutors ??= {};
      s.retiredExecutors[executorId] = true;
      return { state: s, result: undefined };
    });
    // A durable tombstone prevents another begin from racing this removal.
    await rm(path.dirname(replica), { recursive: true, force: true });
  }
  async checkpoint(): Promise<{ hash: string; revision: number }> {
    return this.measured('checkpoint_ms', async () => {
      const { state, now } = await this.metadata.read();
      const s = this.owned(state, now);
      if (Object.keys(s.active).length)
        throw new WorkspaceError('BUSY', 'Checkpoint requires an inactive branch');
      const manifest = Buffer.from(
        JSON.stringify({
          schema: 1,
          scope: this.scope,
          revision: s.revision,
          epoch: s.epoch,
          parent: s.checkpoint?.hash ?? null,
          createdAt: now,
          tree: s.tree,
        })
      );
      const checkpoint = { hash: hash(manifest), revision: s.revision };
      await this.blobs.put(checkpoint.hash, manifest);
      this.event('checkpoint_bytes', manifest.length);
      return this.metadata.mutate((raw, clock) => {
        const latest = this.owned(raw, clock, s.epoch);
        if (latest.revision !== s.revision || Object.keys(latest.active).length)
          throw new WorkspaceError('BUSY', 'Branch changed during checkpoint');
        latest.checkpoint = checkpoint;
        return { state: latest, result: checkpoint };
      });
    });
  }
  async restore(): Promise<number> {
    return this.measured('restore_ms', async () => {
      const s = this.requireScope((await this.metadata.read()).state);
      if (s.checkpoint) {
        const bytes = await this.blobs.get(s.checkpoint.hash);
        if (hash(bytes) !== s.checkpoint.hash)
          throw new WorkspaceError('CORRUPT', 'Checkpoint checksum mismatch');
        const checkpoint = JSON.parse(bytes.toString()) as {
          schema: number;
          scope: WorkspaceScope;
          revision: number;
          tree: Tree;
        };
        if (
          checkpoint.schema !== 1 ||
          checkpoint.scope.tenantId !== this.scope.tenantId ||
          checkpoint.scope.branchId !== this.scope.branchId ||
          checkpoint.revision !== s.checkpoint.revision ||
          checkpoint.revision > s.revision
        )
          throw new WorkspaceError('CORRUPT', 'Checkpoint metadata mismatch');
        validateTree(checkpoint.tree, this.options.exclude);
      }
      // Latest SQL tree includes every acknowledged post-checkpoint revision; all its blobs are durable.
      return this.materialise();
    });
  }
  async drain(): Promise<void> {
    const checkpoint = await this.checkpoint();
    await this.metadata.mutate((raw, now) => {
      const s = this.owned(raw, now);
      if (Object.keys(s.active).length || s.revision !== checkpoint.revision)
        throw new WorkspaceError('BUSY', 'Branch is active');
      s.epoch++;
      s.host = null;
      s.leaseUntil = 0;
      return { state: s, result: undefined };
    });
  }
  async evict(): Promise<void> {
    await evictLocalWorkspace(this);
    this.event('evictions', 1);
  }
}
