/**
 * Best-effort Teams typing indicators while a gateway Task runs.
 *
 * Teams shows a `typing` activity for a few seconds, so it is re-sent on a
 * short timer. State is process-local and keyed by tenant + Session: whichever
 * replica admits or observes the Task may show it, and a missing indicator is
 * harmless. Each refresh re-reads the Task and channel inside the tenant and
 * sends through the fenced address, so a finished Task, a disabled channel, or
 * a revoked address ends it on any replica. A Task whose indicator failed, was
 * refused, or ran past the deadline never restarts it on this replica.
 */

import { type GatewayChannel, TaskStatus, type TenantID } from '@agor/core/types';
import type { TeamsNoticeOutcome } from './teams-notices.js';

/** The Agents SDK typing timer's default refresh. */
export const TEAMS_TYPING_REFRESH_MS = 4_000;
export const TEAMS_TYPING_MAX_MS = 10 * 60_000;
const TEAMS_TYPING_MAX_ACTIVE = 1_024;
const TEAMS_TYPING_MAX_ACTIVE_PER_TENANT = 64;
const TEAMS_TYPING_MAX_ENDED = 4_096;
const TYPING_TASK_STATUSES: ReadonlySet<TaskStatus> = new Set<TaskStatus>([
  TaskStatus.CREATED,
  TaskStatus.DISPATCHING,
  TaskStatus.RUNNING,
]);

export interface TeamsTypingTarget {
  tenantId: TenantID | string;
  sessionId: string;
  taskId: string;
  channelId: string;
  threadId: string;
}

export interface TeamsTypingDependencies {
  runInTenant<T>(tenantId: TenantID | string, work: () => Promise<T>): Promise<T>;
  taskStatus(taskId: string): Promise<TaskStatus | null>;
  loadChannel(channelId: string): Promise<GatewayChannel | null>;
  send(channel: GatewayChannel, threadId: string): Promise<TeamsNoticeOutcome>;
  refreshMs?: number;
  maxMs?: number;
  now?: () => number;
}

interface TypingLoop extends TeamsTypingTarget {
  startedAt: number;
  timer?: NodeJS.Timeout;
}

export class TeamsTypingIndicators {
  private readonly loops = new Map<string, TypingLoop>();
  /** Tenant + Task pairs whose indicator ended for good; insertion-ordered for eviction. */
  private readonly ended = new Set<string>();
  private stopped = false;

  constructor(private readonly deps: TeamsTypingDependencies) {}

  /** Start (or keep) the indicator for this Task; a new Task replaces the Session's old loop. */
  start(target: TeamsTypingTarget): void {
    if (this.stopped) return;
    const key = loopKey(target.tenantId, target.sessionId);
    const existing = this.loops.get(key);
    if (existing && existing.taskId === target.taskId && existing.threadId === target.threadId) {
      return;
    }
    if (existing) this.stop(target.tenantId, target.sessionId);
    if (this.ended.has(loopKey(target.tenantId, target.taskId))) return;
    if (this.loops.size >= TEAMS_TYPING_MAX_ACTIVE) return;
    let tenantLoops = 0;
    for (const loop of this.loops.values()) {
      if (loop.tenantId === target.tenantId) tenantLoops += 1;
    }
    if (tenantLoops >= TEAMS_TYPING_MAX_ACTIVE_PER_TENANT) return;
    const loop: TypingLoop = { ...target, startedAt: this.now() };
    this.loops.set(key, loop);
    void this.refresh(key, loop);
  }

  stop(tenantId: TenantID | string, sessionId: string): void {
    const key = loopKey(tenantId, sessionId);
    const loop = this.loops.get(key);
    if (!loop) return;
    if (loop.timer) clearTimeout(loop.timer);
    this.loops.delete(key);
  }

  /** Daemon shutdown: clear every timer and refuse new loops. */
  stopAll(): void {
    this.stopped = true;
    for (const loop of this.loops.values()) {
      if (loop.timer) clearTimeout(loop.timer);
    }
    this.loops.clear();
    this.ended.clear();
  }

  get activeCount(): number {
    return this.loops.size;
  }

  private now(): number {
    return this.deps.now?.() ?? Date.now();
  }

  private endForTask(loop: TypingLoop): void {
    this.ended.add(loopKey(loop.tenantId, loop.taskId));
    while (this.ended.size > TEAMS_TYPING_MAX_ENDED) {
      const oldest = this.ended.values().next().value;
      if (oldest === undefined) break;
      this.ended.delete(oldest);
    }
  }

  /** `pause` lets a later progress signal restart the loop (e.g. after a permission wait); `end` does not. */
  private async refresh(key: string, loop: TypingLoop): Promise<void> {
    let next: 'continue' | 'pause' | 'end' = 'pause';
    try {
      next = await this.deps.runInTenant(loop.tenantId, async () => {
        if (this.now() - loop.startedAt >= (this.deps.maxMs ?? TEAMS_TYPING_MAX_MS)) return 'end';
        const status = await this.deps.taskStatus(loop.taskId);
        if (!status || !TYPING_TASK_STATUSES.has(status)) return 'pause';
        const channel = await this.deps.loadChannel(loop.channelId);
        if (!channel) return 'end';
        return (await this.deps.send(channel, loop.threadId)) === 'sent' ? 'continue' : 'end';
      });
    } catch {
      next = 'pause';
    }
    if (next === 'end') this.endForTask(loop);
    // Stopped or replaced while this refresh was in flight.
    if (this.loops.get(key) !== loop) return;
    if (next !== 'continue' || this.stopped) {
      this.loops.delete(key);
      return;
    }
    loop.timer = setTimeout(() => {
      void this.refresh(key, loop);
    }, this.deps.refreshMs ?? TEAMS_TYPING_REFRESH_MS);
    loop.timer.unref?.();
  }
}

function loopKey(tenantId: TenantID | string, sessionId: string): string {
  return `${tenantId}\0${sessionId}`;
}
