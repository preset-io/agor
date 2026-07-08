import type {
  Message,
  TaskRuntimeEvent,
  TaskRuntimeEventKind,
  TaskRuntimeEventSource,
  TaskRuntimePhase,
  TaskRuntimeVitals,
} from '@agor/core/types';
import {
  TaskRuntimeEventKind as EventKind,
  MessageRole,
  TaskRuntimePhase as Phase,
  TaskStatus,
} from '@agor/core/types';
import type {
  MessagesService,
  TasksService,
  TasksStreamingService,
} from './sdk-handlers/base/service-clients.js';
import type { StreamingCallbacks } from './sdk-handlers/base/types.js';
import type { AgorClient } from './services/feathers-client.js';

const DEFAULT_MAX_EVENTS = 20;
const DEFAULT_MIN_PATCH_INTERVAL_MS = 5_000;
const CLEARED_ACTIVE_TOOL = null as unknown as TaskRuntimeVitals['active_tool'];

export interface RuntimeVitalsReporterOptions {
  client: Pick<AgorClient, 'service'>;
  taskId: string;
  toolName: string;
  now?: () => Date;
  maxEvents?: number;
  minPatchIntervalMs?: number;
  warn?: (...args: unknown[]) => void;
}

export interface RuntimeVitalsRecordOptions {
  phase?: TaskRuntimePhase;
  source?: TaskRuntimeEventSource;
  meaningful?: boolean;
  toolName?: string;
  toolUseId?: string;
  forceFlush?: boolean;
}

export class TaskRuntimeVitalsReporter {
  private readonly now: () => Date;
  private readonly maxEvents: number;
  private readonly minPatchIntervalMs: number;
  private readonly warn: (...args: unknown[]) => void;
  private current: TaskRuntimeVitals | undefined;
  private lastFlushAtMs = 0;
  private pendingFlush: Promise<void> = Promise.resolve();
  private trailingFlushTimer: ReturnType<typeof setTimeout> | undefined;
  private stopped = false;

  constructor(private readonly options: RuntimeVitalsReporterOptions) {
    this.now = options.now ?? (() => new Date());
    this.maxEvents = Math.max(1, Math.floor(options.maxEvents ?? DEFAULT_MAX_EVENTS));
    this.minPatchIntervalMs = Math.max(
      0,
      Math.floor(options.minPatchIntervalMs ?? DEFAULT_MIN_PATCH_INTERVAL_MS)
    );
    this.warn = options.warn ?? console.warn;
  }

  get snapshot(): TaskRuntimeVitals | undefined {
    return this.current;
  }

  get taskId(): string {
    return this.options.taskId;
  }

  async record(
    kind: TaskRuntimeEventKind,
    options: RuntimeVitalsRecordOptions = {}
  ): Promise<void> {
    if (this.stopped) return;
    const previous = this.current;
    const vitals = this.applyEvent(kind, options);
    const phaseChanged = !previous || previous.phase !== vitals.phase;
    const firstMeaningfulProgress =
      options.meaningful === true && previous?.first_meaningful_progress_at === undefined;
    const shouldFlush =
      options.forceFlush === true ||
      phaseChanged ||
      firstMeaningfulProgress ||
      this.minPatchIntervalMs === 0 ||
      this.now().getTime() - this.lastFlushAtMs >= this.minPatchIntervalMs;

    if (!shouldFlush) {
      this.scheduleTrailingFlush();
      return;
    }

    this.cancelTrailingFlush();
    await this.enqueueFlush(vitals);
  }

  /**
   * Build the final vitals snapshot to include in the terminal task patch.
   * This stops later passive writes and waits for older queued writes so the
   * terminal patch lands last when the caller includes this snapshot.
   */
  async terminalSnapshot(
    kind: TaskRuntimeEventKind,
    options: RuntimeVitalsRecordOptions = {}
  ): Promise<TaskRuntimeVitals> {
    this.stopped = true;
    this.cancelTrailingFlush();
    await this.pendingFlush.catch(() => undefined);
    return this.applyEvent(kind, { ...options, forceFlush: false });
  }

  stop(): void {
    this.stopped = true;
    this.cancelTrailingFlush();
  }

  private applyEvent(
    kind: TaskRuntimeEventKind,
    options: RuntimeVitalsRecordOptions
  ): TaskRuntimeVitals {
    const at = this.now().toISOString();
    const source = options.source ?? 'executor';
    const phase = options.phase ?? this.current?.phase ?? Phase.RUNNING;
    const event: TaskRuntimeEvent = {
      kind,
      at,
      source,
      phase,
      ...(options.toolName ? { tool_name: options.toolName } : {}),
      ...(options.toolUseId ? { tool_use_id: options.toolUseId } : {}),
    };

    const previous = this.current;
    const previousCounters = previous?.counters ?? {};
    const phaseChanged = !previous || previous.phase !== phase;
    const meaningful = options.meaningful === true;
    const counters: NonNullable<TaskRuntimeVitals['counters']> = {
      ...previousCounters,
      events: (previousCounters.events ?? 0) + 1,
    };

    if (meaningful) {
      counters.meaningful_progress_events = (previousCounters.meaningful_progress_events ?? 0) + 1;
    }
    if (kind === EventKind.TOOL_START)
      counters.tool_starts = (previousCounters.tool_starts ?? 0) + 1;
    if (kind === EventKind.TOOL_COMPLETE) {
      counters.tool_completes = (previousCounters.tool_completes ?? 0) + 1;
    }
    if (kind === EventKind.THINKING)
      counters.thinking_events = (previousCounters.thinking_events ?? 0) + 1;
    if (kind === EventKind.STREAM_START)
      counters.stream_starts = (previousCounters.stream_starts ?? 0) + 1;
    if (kind === EventKind.ASSISTANT_MESSAGE) {
      counters.assistant_messages = (previousCounters.assistant_messages ?? 0) + 1;
    }
    if (kind === EventKind.PERMISSION_WAIT_START) {
      counters.permission_waits = (previousCounters.permission_waits ?? 0) + 1;
    }

    const recentEvents = [...(previous?.recent_events ?? []), event].slice(-this.maxEvents);
    const lastMeaningful = meaningful ? at : previous?.last_meaningful_progress_at;
    const firstMeaningful = meaningful
      ? (previous?.first_meaningful_progress_at ?? at)
      : previous?.first_meaningful_progress_at;

    let activeTool = previous?.active_tool;
    if (kind === EventKind.TOOL_START) {
      activeTool = {
        ...(options.toolName ? { tool_name: options.toolName } : {}),
        ...(options.toolUseId ? { tool_use_id: options.toolUseId } : {}),
        started_at: at,
        last_activity_at: at,
      };
    } else if (kind === EventKind.TOOL_PROGRESS && activeTool) {
      activeTool = { ...activeTool, last_activity_at: at };
    } else if (kind === EventKind.TOOL_COMPLETE) {
      const sameTool =
        !activeTool ||
        !options.toolUseId ||
        !activeTool.tool_use_id ||
        activeTool.tool_use_id === options.toolUseId;
      activeTool = sameTool ? CLEARED_ACTIVE_TOOL : activeTool;
    } else if (isTerminalTaskRuntimeEvent(kind)) {
      activeTool = CLEARED_ACTIVE_TOOL;
    }

    this.current = {
      schema_version: 1,
      phase,
      phase_started_at: phaseChanged ? at : (previous?.phase_started_at ?? at),
      last_activity_at: at,
      ...(lastMeaningful ? { last_meaningful_progress_at: lastMeaningful } : {}),
      ...(firstMeaningful ? { first_meaningful_progress_at: firstMeaningful } : {}),
      last_event: event,
      ...(activeTool !== undefined ? { active_tool: activeTool } : {}),
      counters,
      recent_events: recentEvents,
    };

    return this.current;
  }

  private scheduleTrailingFlush(): void {
    if (this.trailingFlushTimer || this.stopped) return;

    const elapsedMs = this.now().getTime() - this.lastFlushAtMs;
    const delayMs = Math.max(0, this.minPatchIntervalMs - elapsedMs);
    this.trailingFlushTimer = setTimeout(() => {
      this.trailingFlushTimer = undefined;
      if (this.stopped || !this.current) return;
      void this.enqueueFlush(this.current);
    }, delayMs);
  }

  private cancelTrailingFlush(): void {
    if (!this.trailingFlushTimer) return;
    clearTimeout(this.trailingFlushTimer);
    this.trailingFlushTimer = undefined;
  }

  private async enqueueFlush(vitals: TaskRuntimeVitals): Promise<void> {
    this.lastFlushAtMs = this.now().getTime();
    const patch = async () => {
      if (this.stopped) return;
      try {
        await this.options.client.service('tasks').patch(this.options.taskId, {
          runtime_vitals: vitals,
        });
      } catch (error) {
        this.warn(
          '[runtime-vitals] Failed to write task runtime vitals:',
          error instanceof Error ? error.message : String(error)
        );
      }
    };

    this.pendingFlush = this.pendingFlush.then(patch, patch);
    await this.pendingFlush;
  }
}

function isTerminalTaskRuntimeEvent(kind: TaskRuntimeEventKind): boolean {
  return (
    kind === EventKind.TURN_COMPLETED ||
    kind === EventKind.TURN_FAILED ||
    kind === EventKind.TURN_STOPPED ||
    kind === EventKind.TURN_TIMED_OUT
  );
}

export function taskStatusToRuntimePhase(status: string | undefined): TaskRuntimePhase | undefined {
  switch (status) {
    case TaskStatus.RUNNING:
      return Phase.RUNNING;
    case TaskStatus.STOPPING:
      return Phase.STOPPING;
    case TaskStatus.AWAITING_PERMISSION:
      return Phase.AWAITING_PERMISSION;
    case TaskStatus.COMPLETED:
      return Phase.COMPLETED;
    case TaskStatus.FAILED:
      return Phase.FAILED;
    case TaskStatus.STOPPED:
      return Phase.STOPPED;
    case TaskStatus.TIMED_OUT:
      return Phase.TIMED_OUT;
    default:
      return undefined;
  }
}

export function terminalEventForStatus(
  status: string | undefined
): TaskRuntimeEventKind | undefined {
  switch (status) {
    case TaskStatus.COMPLETED:
      return EventKind.TURN_COMPLETED;
    case TaskStatus.FAILED:
      return EventKind.TURN_FAILED;
    case TaskStatus.STOPPED:
      return EventKind.TURN_STOPPED;
    case TaskStatus.TIMED_OUT:
      return EventKind.TURN_TIMED_OUT;
    default:
      return undefined;
  }
}

export function isMeaningfulTaskRuntimeEvent(kind: TaskRuntimeEventKind): boolean {
  return (
    kind === EventKind.FIRST_AGENT_EVENT ||
    kind === EventKind.STREAM_START ||
    kind === EventKind.THINKING ||
    kind === EventKind.ASSISTANT_MESSAGE ||
    kind === EventKind.TOOL_START ||
    kind === EventKind.TOOL_PROGRESS ||
    kind === EventKind.TOOL_COMPLETE
  );
}

function extractToolField(
  data: Record<string, unknown>,
  key: 'tool_name' | 'tool_use_id'
): string | undefined {
  const value = data[key];
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

export function wrapStreamingCallbacksWithRuntimeVitals(
  callbacks: StreamingCallbacks,
  reporter: TaskRuntimeVitalsReporter
): StreamingCallbacks {
  return {
    ...callbacks,
    onStreamStart: async (...args) => {
      await callbacks.onStreamStart(...args);
      void reporter.record(EventKind.STREAM_START, {
        source: 'sdk',
        phase: Phase.RUNNING,
        meaningful: true,
      });
    },
    onThinkingStart: async (...args) => {
      await callbacks.onThinkingStart?.(...args);
      void reporter.record(EventKind.THINKING, {
        source: 'sdk',
        phase: Phase.RUNNING,
        meaningful: true,
      });
    },
    onThinkingChunk: async (...args) => {
      await callbacks.onThinkingChunk?.(...args);
      void reporter.record(EventKind.THINKING, {
        source: 'sdk',
        phase: Phase.RUNNING,
        meaningful: true,
      });
    },
  };
}

export function wrapTasksStreamingServiceWithRuntimeVitals(
  service: TasksStreamingService,
  reporter: TaskRuntimeVitalsReporter
): TasksStreamingService {
  return {
    ...service,
    create: async (data) => {
      const result = await service.create(data);
      if (data.event === 'tool:start') {
        void reporter.record(EventKind.TOOL_START, {
          source: 'tool',
          phase: Phase.TOOL_RUNNING,
          meaningful: true,
          toolName: extractToolField(data.data, 'tool_name'),
          toolUseId: extractToolField(data.data, 'tool_use_id'),
        });
      } else if (data.event === 'tool:complete') {
        void reporter.record(EventKind.TOOL_COMPLETE, {
          source: 'tool',
          phase: Phase.RUNNING,
          meaningful: true,
          toolName: extractToolField(data.data, 'tool_name'),
          toolUseId: extractToolField(data.data, 'tool_use_id'),
        });
      } else if (data.event === 'thinking:chunk') {
        void reporter.record(EventKind.THINKING, {
          source: 'sdk',
          phase: Phase.RUNNING,
          meaningful: true,
        });
      }
      return result;
    },
  };
}

export function wrapMessagesServiceWithRuntimeVitals(
  service: MessagesService,
  reporter: TaskRuntimeVitalsReporter
): MessagesService {
  return {
    ...service,
    patch: service.patch.bind(service),
    create: async (data) => {
      const result = await service.create(data);
      if (isAssistantMessage(result)) {
        void reporter.record(EventKind.ASSISTANT_MESSAGE, {
          source: 'sdk',
          phase: Phase.RUNNING,
          meaningful: true,
        });
      }
      return result;
    },
  };
}

export function wrapTasksServiceWithRuntimeVitals(
  service: TasksService,
  reporter: TaskRuntimeVitalsReporter
): TasksService {
  return {
    ...service,
    get: service.get.bind(service),
    emit: service.emit.bind(service),
    patch: async (id, data) => {
      const result = await service.patch(id, data);
      if (id !== reporter.taskId) return result;

      const status = typeof data.status === 'string' ? data.status : undefined;
      const phase = taskStatusToRuntimePhase(status);
      if (!phase) return result;

      const terminalKind = terminalEventForStatus(status);
      if (terminalKind) {
        const vitals = await reporter.terminalSnapshot(terminalKind, {
          source: 'executor',
          phase,
          meaningful: false,
        });
        try {
          await service.patch(id, { runtime_vitals: vitals });
        } catch (error) {
          console.warn(
            '[runtime-vitals] Failed to write terminal task runtime vitals:',
            error instanceof Error ? error.message : String(error)
          );
        }
        return result;
      }

      if (status === TaskStatus.AWAITING_PERMISSION) {
        void reporter.record(EventKind.PERMISSION_WAIT_START, {
          source: 'permission',
          phase,
          forceFlush: true,
        });
      } else if (status === TaskStatus.RUNNING) {
        const previousPhase = reporter.snapshot?.phase;
        if (previousPhase === Phase.AWAITING_PERMISSION) {
          void reporter.record(EventKind.PERMISSION_WAIT_END, {
            source: 'permission',
            phase,
            forceFlush: true,
          });
        } else {
          void reporter.record(EventKind.TASK_STATUS, { source: 'executor', phase });
        }
      } else {
        void reporter.record(EventKind.TASK_STATUS, { source: 'executor', phase });
      }

      return result;
    },
  };
}

function isAssistantMessage(message: Message): boolean {
  return message.role === MessageRole.ASSISTANT || message.type === 'assistant';
}
