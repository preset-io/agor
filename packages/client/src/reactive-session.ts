import type {
  AgorClient,
  SessionPromptOptions,
  SessionPromptResult,
} from '../../core/src/api/index';
import type { Message, Session, Task } from '../../core/src/types/index';

export type TaskHydrationMode = 'none' | 'lazy' | 'eager';

export interface ReactiveSessionOptions {
  /**
   * Message hydration policy:
   * - none: do not auto-load task messages
   * - lazy: load messages per task via loadTaskMessages() (default)
   * - eager: load all session messages during bootstrap
   */
  taskHydration?: TaskHydrationMode;
}

export interface StreamingMessageState {
  message_id: string;
  session_id: string;
  task_id?: string;
  role: 'assistant';
  content: string;
  thinkingContent?: string;
  timestamp: string;
  isStreaming: boolean;
  isThinking?: boolean;
  error?: string;
}

export interface ToolExecutionState {
  toolUseId: string;
  toolName: string;
  status: 'executing' | 'complete';
}

/**
 * Named collection aliases improve IntelliSense discoverability for nested session state.
 */
export type ReactiveMessagesByTask = Map<string, Message[]>;
export type ReactiveStreamingMessagesById = Map<string, StreamingMessageState>;
export type ReactiveToolsByTask = Map<string, ToolExecutionState[]>;
export type ReactiveLoadedTaskIds = Set<string>;

export interface ReactiveSessionState {
  sessionId: string;
  session: Session | null;
  tasks: Task[];
  messagesByTask: ReactiveMessagesByTask;
  queuedMessages: Message[];
  streamingMessages: ReactiveStreamingMessagesById;
  toolsByTask: ReactiveToolsByTask;
  loadedTaskIds: ReactiveLoadedTaskIds;
  connected: boolean;
  loading: boolean;
  error: string | null;
  lastSyncedAt: string | null;
}

type Listener = () => void;

interface QueueFindResult {
  data?: Message[];
}

interface ToolStartEvent {
  task_id: string;
  session_id: string;
  tool_use_id: string;
  tool_name: string;
}

interface ToolCompleteEvent {
  task_id: string;
  session_id: string;
  tool_use_id: string;
}

interface StreamingStartEvent {
  message_id: string;
  session_id: string;
  task_id?: string;
  role: 'assistant';
  timestamp: string;
}

interface StreamingChunkEvent {
  message_id: string;
  session_id: string;
  chunk: string;
}

interface StreamingEndEvent {
  message_id: string;
  session_id: string;
}

interface StreamingErrorEvent {
  message_id: string;
  session_id: string;
  error: string;
}

interface ThinkingStartEvent {
  message_id: string;
  session_id: string;
  task_id?: string;
  timestamp: string;
}

interface ThinkingChunkEvent {
  message_id: string;
  session_id: string;
  chunk: string;
}

interface ThinkingEndEvent {
  message_id: string;
  session_id: string;
}

export class ReactiveSessionHandle {
  private readonly client: AgorClient;
  private readonly options: Required<ReactiveSessionOptions>;
  private readonly listeners = new Set<Listener>();
  private readonly disposeCallbacks: Array<() => void> = [];
  private readyPromise: Promise<void>;
  private disposed = false;

  private stateSnapshot: ReactiveSessionState;

  constructor(client: AgorClient, sessionId: string, options?: ReactiveSessionOptions) {
    this.client = client;
    this.options = {
      taskHydration: options?.taskHydration ?? 'lazy',
    };
    this.stateSnapshot = {
      sessionId,
      session: null,
      tasks: [],
      messagesByTask: new Map(),
      queuedMessages: [],
      streamingMessages: new Map(),
      toolsByTask: new Map(),
      loadedTaskIds: new Set(),
      connected: !!client.io?.connected,
      loading: true,
      error: null,
      lastSyncedAt: null,
    };

    this.attachListeners();
    this.readyPromise = this.bootstrap();
  }

  get sessionId(): string {
    return this.stateSnapshot.sessionId;
  }

  get state(): ReactiveSessionState {
    return this.stateSnapshot;
  }

  /**
   * Returns the task model for a task id if currently known in state.
   */
  getTask(taskId: string): Task | undefined {
    return this.stateSnapshot.tasks.find((task) => task.task_id === taskId);
  }

  /**
   * Returns task messages currently cached in reactive state.
   * This does not trigger hydration. Use loadTaskMessages() first in lazy mode.
   */
  getTaskMessages(taskId: string): readonly Message[] {
    return this.stateSnapshot.messagesByTask.get(taskId) || [];
  }

  /**
   * Returns whether a task's messages are currently hydrated in state.
   */
  isTaskLoaded(taskId: string): boolean {
    return this.stateSnapshot.loadedTaskIds.has(taskId);
  }

  /**
   * Returns tool executions currently tracked for a task.
   */
  getTaskTools(taskId: string): readonly ToolExecutionState[] {
    return this.stateSnapshot.toolsByTask.get(taskId) || [];
  }

  /**
   * Returns one streaming message by message id, if present.
   */
  getStreamingMessage(messageId: string): StreamingMessageState | undefined {
    return this.stateSnapshot.streamingMessages.get(messageId);
  }

  /**
   * Returns currently tracked streaming messages. Optionally filter by task.
   */
  getStreamingMessages(taskId?: string): StreamingMessageState[] {
    const messages = Array.from(this.stateSnapshot.streamingMessages.values());
    return taskId ? messages.filter((message) => message.task_id === taskId) : messages;
  }

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  async ready(): Promise<void> {
    await this.readyPromise;
  }

  async prompt(prompt: string, options?: SessionPromptOptions): Promise<SessionPromptResult> {
    return this.client.sessions.prompt(this.sessionId, prompt, options);
  }

  async loadTaskMessages(taskId: string): Promise<Message[]> {
    this.assertNotDisposed();
    const messages = await this.client.service('messages').findAll({
      query: {
        task_id: taskId,
        $sort: { index: 1 },
      },
    });
    this.updateState((prev) => {
      const nextByTask = new Map(prev.messagesByTask);
      nextByTask.set(taskId, sortMessagesByIndex(messages));
      const nextLoaded = new Set(prev.loadedTaskIds);
      nextLoaded.add(taskId);
      return {
        ...prev,
        messagesByTask: nextByTask,
        loadedTaskIds: nextLoaded,
        lastSyncedAt: new Date().toISOString(),
      };
    });
    return messages;
  }

  unloadTaskMessages(taskId: string): void {
    this.assertNotDisposed();
    this.updateState((prev) => {
      if (!prev.loadedTaskIds.has(taskId) && !prev.messagesByTask.has(taskId)) {
        return prev;
      }
      const nextByTask = new Map(prev.messagesByTask);
      nextByTask.delete(taskId);
      const nextLoaded = new Set(prev.loadedTaskIds);
      nextLoaded.delete(taskId);
      return {
        ...prev,
        messagesByTask: nextByTask,
        loadedTaskIds: nextLoaded,
      };
    });
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const cleanup of this.disposeCallbacks) {
      cleanup();
    }
    this.disposeCallbacks.length = 0;
    this.listeners.clear();
  }

  private assertNotDisposed(): void {
    if (this.disposed) {
      throw new Error(`Reactive session ${this.sessionId} is disposed`);
    }
  }

  private notify(): void {
    for (const listener of this.listeners) {
      listener();
    }
  }

  private updateState(
    updater: (previous: ReactiveSessionState) => ReactiveSessionState
  ): ReactiveSessionState {
    const next = updater(this.stateSnapshot);
    this.stateSnapshot = next;
    this.notify();
    return next;
  }

  private async bootstrap(): Promise<void> {
    try {
      const [session, tasks, queueResult] = await Promise.all([
        this.client.service('sessions').get(this.sessionId),
        this.client.service('tasks').findAll({
          query: {
            session_id: this.sessionId,
            $sort: { created_at: 1 },
          },
        }),
        this.client
          .service(`/sessions/${this.sessionId}/messages/queue`)
          .find()
          .catch(() => ({ data: [] }) as QueueFindResult),
      ]);

      let messagesByTask = new Map<string, Message[]>();
      let loadedTaskIds = new Set<string>();

      if (this.options.taskHydration === 'eager') {
        const allMessages = await this.client.service('messages').findAll({
          query: {
            session_id: this.sessionId,
            $sort: { index: 1 },
          },
        });
        messagesByTask = groupMessagesByTask(allMessages);
        loadedTaskIds = new Set(messagesByTask.keys());
      }

      this.updateState((prev) => ({
        ...prev,
        session,
        tasks,
        messagesByTask,
        loadedTaskIds,
        queuedMessages: sortMessagesByQueuePosition((queueResult as QueueFindResult).data || []),
        loading: false,
        error: null,
        lastSyncedAt: new Date().toISOString(),
      }));
    } catch (error) {
      this.updateState((prev) => ({
        ...prev,
        loading: false,
        error: error instanceof Error ? error.message : 'Failed to bootstrap reactive session',
      }));
    }
  }

  private attachListeners(): void {
    const sessionsService = this.client.service('sessions');
    const tasksService = this.client.service('tasks');
    const messagesService = this.client.service('messages');

    const onSocketConnect = () => {
      if (this.disposed) return;
      this.updateState((prev) => ({ ...prev, connected: true }));
      this.readyPromise = this.resync();
    };
    const onSocketDisconnect = () => {
      if (this.disposed) return;
      this.updateState((prev) => ({ ...prev, connected: false }));
    };
    this.client.io.on('connect', onSocketConnect);
    this.client.io.on('disconnect', onSocketDisconnect);
    this.disposeCallbacks.push(() => this.client.io.off('connect', onSocketConnect));
    this.disposeCallbacks.push(() => this.client.io.off('disconnect', onSocketDisconnect));

    const onSessionPatched = (session: Session) => {
      if (session.session_id !== this.sessionId) return;
      this.updateState((prev) => ({
        ...prev,
        session,
        lastSyncedAt: new Date().toISOString(),
      }));
    };
    const onSessionRemoved = (session: Session) => {
      if (session.session_id !== this.sessionId) return;
      this.updateState((prev) => ({
        ...prev,
        session: null,
        error: 'Session was removed',
        lastSyncedAt: new Date().toISOString(),
      }));
    };
    sessionsService.on('patched', onSessionPatched);
    sessionsService.on('updated', onSessionPatched);
    sessionsService.on('removed', onSessionRemoved);
    this.disposeCallbacks.push(() => sessionsService.removeListener('patched', onSessionPatched));
    this.disposeCallbacks.push(() => sessionsService.removeListener('updated', onSessionPatched));
    this.disposeCallbacks.push(() => sessionsService.removeListener('removed', onSessionRemoved));

    const onTaskCreated = (task: Task) => {
      if (task.session_id !== this.sessionId) return;
      this.updateState((prev) => {
        if (prev.tasks.some((t) => t.task_id === task.task_id)) return prev;
        return {
          ...prev,
          tasks: [...prev.tasks, task],
          lastSyncedAt: new Date().toISOString(),
        };
      });
    };
    const onTaskPatched = (task: Task) => {
      if (task.session_id !== this.sessionId) return;
      this.updateState((prev) => {
        const index = prev.tasks.findIndex((t) => t.task_id === task.task_id);
        if (index === -1) {
          return {
            ...prev,
            tasks: [...prev.tasks, task],
            lastSyncedAt: new Date().toISOString(),
          };
        }
        const nextTasks = [...prev.tasks];
        nextTasks[index] = task;
        return {
          ...prev,
          tasks: nextTasks,
          lastSyncedAt: new Date().toISOString(),
        };
      });
    };
    const onTaskRemoved = (task: Task) => {
      if (task.session_id !== this.sessionId) return;
      this.updateState((prev) => {
        const nextByTask = new Map(prev.messagesByTask);
        nextByTask.delete(task.task_id);
        const nextLoaded = new Set(prev.loadedTaskIds);
        nextLoaded.delete(task.task_id);
        const nextTools = new Map(prev.toolsByTask);
        nextTools.delete(task.task_id);
        return {
          ...prev,
          tasks: prev.tasks.filter((t) => t.task_id !== task.task_id),
          messagesByTask: nextByTask,
          loadedTaskIds: nextLoaded,
          toolsByTask: nextTools,
          lastSyncedAt: new Date().toISOString(),
        };
      });
    };
    tasksService.on('created', onTaskCreated);
    tasksService.on('patched', onTaskPatched);
    tasksService.on('updated', onTaskPatched);
    tasksService.on('removed', onTaskRemoved);
    this.disposeCallbacks.push(() => tasksService.removeListener('created', onTaskCreated));
    this.disposeCallbacks.push(() => tasksService.removeListener('patched', onTaskPatched));
    this.disposeCallbacks.push(() => tasksService.removeListener('updated', onTaskPatched));
    this.disposeCallbacks.push(() => tasksService.removeListener('removed', onTaskRemoved));

    const onToolStart = (event: ToolStartEvent) => {
      if (event.session_id !== this.sessionId) return;
      this.updateState((prev) => {
        const existing = prev.toolsByTask.get(event.task_id) || [];
        if (existing.some((t) => t.toolUseId === event.tool_use_id)) return prev;
        const nextTools = new Map(prev.toolsByTask);
        nextTools.set(event.task_id, [
          ...existing,
          {
            toolUseId: event.tool_use_id,
            toolName: event.tool_name,
            status: 'executing',
          },
        ]);
        return {
          ...prev,
          toolsByTask: nextTools,
        };
      });
    };
    const onToolComplete = (event: ToolCompleteEvent) => {
      if (event.session_id !== this.sessionId) return;
      this.updateState((prev) => {
        const existing = prev.toolsByTask.get(event.task_id) || [];
        if (existing.length === 0) return prev;
        const nextTools = new Map(prev.toolsByTask);
        nextTools.set(
          event.task_id,
          existing.map((tool) =>
            tool.toolUseId === event.tool_use_id ? { ...tool, status: 'complete' as const } : tool
          )
        );
        return {
          ...prev,
          toolsByTask: nextTools,
        };
      });
    };
    tasksService.on('tool:start', onToolStart as (...args: unknown[]) => void);
    tasksService.on('tool:complete', onToolComplete as (...args: unknown[]) => void);
    this.disposeCallbacks.push(() =>
      tasksService.removeListener('tool:start', onToolStart as (...args: unknown[]) => void)
    );
    this.disposeCallbacks.push(() =>
      tasksService.removeListener('tool:complete', onToolComplete as (...args: unknown[]) => void)
    );

    const onMessageCreated = (message: Message) => {
      if (message.session_id !== this.sessionId) return;
      this.updateState((prev) => {
        const nextQueued = prev.queuedMessages.filter((m) => m.message_id !== message.message_id);
        const nextStreaming = new Map(prev.streamingMessages);
        nextStreaming.delete(message.message_id);
        if (!message.task_id) {
          return {
            ...prev,
            queuedMessages: nextQueued,
            streamingMessages: nextStreaming,
            lastSyncedAt: new Date().toISOString(),
          };
        }

        const shouldTrackMessages =
          this.options.taskHydration === 'eager' || prev.loadedTaskIds.has(message.task_id);

        if (!shouldTrackMessages) {
          return {
            ...prev,
            queuedMessages: nextQueued,
            streamingMessages: nextStreaming,
            lastSyncedAt: new Date().toISOString(),
          };
        }

        const nextByTask = new Map(prev.messagesByTask);
        const current = nextByTask.get(message.task_id) || [];
        if (!current.some((m) => m.message_id === message.message_id)) {
          nextByTask.set(message.task_id, sortMessagesByIndex([...current, message]));
        }

        return {
          ...prev,
          messagesByTask: nextByTask,
          queuedMessages: nextQueued,
          streamingMessages: nextStreaming,
          lastSyncedAt: new Date().toISOString(),
        };
      });
    };

    const onMessagePatched = (message: Message) => {
      const taskId = message.task_id;
      if (message.session_id !== this.sessionId || !taskId) return;
      this.updateState((prev) => {
        const current = prev.messagesByTask.get(taskId);
        if (!current) return prev;
        const index = current.findIndex((m) => m.message_id === message.message_id);
        if (index === -1) return prev;
        const nextByTask = new Map(prev.messagesByTask);
        const nextMessages = [...current];
        nextMessages[index] = message;
        nextByTask.set(taskId, nextMessages);
        return {
          ...prev,
          messagesByTask: nextByTask,
          lastSyncedAt: new Date().toISOString(),
        };
      });
    };

    const onMessageRemoved = (message: Message) => {
      if (message.session_id !== this.sessionId) return;
      const taskId = message.task_id;
      this.updateState((prev) => {
        const nextQueued = prev.queuedMessages.filter((m) => m.message_id !== message.message_id);
        const nextStreaming = new Map(prev.streamingMessages);
        nextStreaming.delete(message.message_id);
        if (!taskId) {
          return {
            ...prev,
            queuedMessages: nextQueued,
            streamingMessages: nextStreaming,
            lastSyncedAt: new Date().toISOString(),
          };
        }
        const current = prev.messagesByTask.get(taskId) || [];
        const nextByTask = new Map(prev.messagesByTask);
        nextByTask.set(
          taskId,
          current.filter((m) => m.message_id !== message.message_id)
        );
        return {
          ...prev,
          queuedMessages: nextQueued,
          streamingMessages: nextStreaming,
          messagesByTask: nextByTask,
          lastSyncedAt: new Date().toISOString(),
        };
      });
    };

    const onQueued = (message: Message) => {
      if (message.session_id !== this.sessionId) return;
      this.updateState((prev) => {
        if (prev.queuedMessages.some((m) => m.message_id === message.message_id)) {
          return prev;
        }
        return {
          ...prev,
          queuedMessages: sortMessagesByQueuePosition([...prev.queuedMessages, message]),
          lastSyncedAt: new Date().toISOString(),
        };
      });
    };

    const onStreamingStart = (event: StreamingStartEvent) => {
      if (event.session_id !== this.sessionId) return;
      this.updateState((prev) => {
        const nextStreaming = new Map(prev.streamingMessages);
        nextStreaming.set(event.message_id, {
          message_id: event.message_id,
          session_id: event.session_id,
          task_id: event.task_id,
          role: event.role,
          content: '',
          thinkingContent: '',
          timestamp: event.timestamp,
          isStreaming: true,
        });
        return {
          ...prev,
          streamingMessages: nextStreaming,
        };
      });
    };

    const onStreamingChunk = (event: StreamingChunkEvent) => {
      if (event.session_id !== this.sessionId) return;
      this.updateState((prev) => {
        const current = prev.streamingMessages.get(event.message_id);
        if (!current) return prev;
        const nextStreaming = new Map(prev.streamingMessages);
        nextStreaming.set(event.message_id, {
          ...current,
          content: current.content + event.chunk,
        });
        return {
          ...prev,
          streamingMessages: nextStreaming,
        };
      });
    };

    const onStreamingEnd = (event: StreamingEndEvent) => {
      if (event.session_id !== this.sessionId) return;
      this.updateState((prev) => {
        const current = prev.streamingMessages.get(event.message_id);
        if (!current) return prev;
        const nextStreaming = new Map(prev.streamingMessages);
        nextStreaming.set(event.message_id, {
          ...current,
          isStreaming: false,
        });
        return {
          ...prev,
          streamingMessages: nextStreaming,
        };
      });
    };

    const onStreamingError = (event: StreamingErrorEvent) => {
      if (event.session_id !== this.sessionId) return;
      this.updateState((prev) => {
        const current = prev.streamingMessages.get(event.message_id);
        if (!current) return prev;
        const nextStreaming = new Map(prev.streamingMessages);
        nextStreaming.set(event.message_id, {
          ...current,
          error: event.error,
          isStreaming: false,
        });
        return {
          ...prev,
          streamingMessages: nextStreaming,
        };
      });
    };

    const onThinkingStart = (event: ThinkingStartEvent) => {
      if (event.session_id !== this.sessionId) return;
      this.updateState((prev) => {
        const nextStreaming = new Map(prev.streamingMessages);
        const existing = nextStreaming.get(event.message_id);
        nextStreaming.set(event.message_id, {
          message_id: event.message_id,
          session_id: event.session_id,
          task_id: event.task_id ?? existing?.task_id,
          role: 'assistant',
          content: existing?.content || '',
          thinkingContent: existing?.thinkingContent || '',
          timestamp: existing?.timestamp || event.timestamp,
          isStreaming: true,
          isThinking: true,
        });
        return {
          ...prev,
          streamingMessages: nextStreaming,
        };
      });
    };

    const onThinkingChunk = (event: ThinkingChunkEvent) => {
      if (event.session_id !== this.sessionId) return;
      this.updateState((prev) => {
        const current = prev.streamingMessages.get(event.message_id);
        if (!current) return prev;
        const nextStreaming = new Map(prev.streamingMessages);
        nextStreaming.set(event.message_id, {
          ...current,
          isThinking: true,
          thinkingContent: (current.thinkingContent || '') + event.chunk,
        });
        return {
          ...prev,
          streamingMessages: nextStreaming,
        };
      });
    };

    const onThinkingEnd = (event: ThinkingEndEvent) => {
      if (event.session_id !== this.sessionId) return;
      this.updateState((prev) => {
        const current = prev.streamingMessages.get(event.message_id);
        if (!current) return prev;
        const nextStreaming = new Map(prev.streamingMessages);
        nextStreaming.set(event.message_id, {
          ...current,
          isThinking: false,
        });
        return {
          ...prev,
          streamingMessages: nextStreaming,
        };
      });
    };

    messagesService.on('created', onMessageCreated);
    messagesService.on('patched', onMessagePatched);
    messagesService.on('updated', onMessagePatched);
    messagesService.on('removed', onMessageRemoved);
    messagesService.on('queued', onQueued as (...args: unknown[]) => void);
    messagesService.on('streaming:start', onStreamingStart as (...args: unknown[]) => void);
    messagesService.on('streaming:chunk', onStreamingChunk as (...args: unknown[]) => void);
    messagesService.on('streaming:end', onStreamingEnd as (...args: unknown[]) => void);
    messagesService.on('streaming:error', onStreamingError as (...args: unknown[]) => void);
    messagesService.on('thinking:start', onThinkingStart as (...args: unknown[]) => void);
    messagesService.on('thinking:chunk', onThinkingChunk as (...args: unknown[]) => void);
    messagesService.on('thinking:end', onThinkingEnd as (...args: unknown[]) => void);

    this.disposeCallbacks.push(() => messagesService.removeListener('created', onMessageCreated));
    this.disposeCallbacks.push(() => messagesService.removeListener('patched', onMessagePatched));
    this.disposeCallbacks.push(() => messagesService.removeListener('updated', onMessagePatched));
    this.disposeCallbacks.push(() => messagesService.removeListener('removed', onMessageRemoved));
    this.disposeCallbacks.push(() =>
      messagesService.removeListener('queued', onQueued as (...args: unknown[]) => void)
    );
    this.disposeCallbacks.push(() =>
      messagesService.removeListener(
        'streaming:start',
        onStreamingStart as (...args: unknown[]) => void
      )
    );
    this.disposeCallbacks.push(() =>
      messagesService.removeListener(
        'streaming:chunk',
        onStreamingChunk as (...args: unknown[]) => void
      )
    );
    this.disposeCallbacks.push(() =>
      messagesService.removeListener(
        'streaming:end',
        onStreamingEnd as (...args: unknown[]) => void
      )
    );
    this.disposeCallbacks.push(() =>
      messagesService.removeListener(
        'streaming:error',
        onStreamingError as (...args: unknown[]) => void
      )
    );
    this.disposeCallbacks.push(() =>
      messagesService.removeListener(
        'thinking:start',
        onThinkingStart as (...args: unknown[]) => void
      )
    );
    this.disposeCallbacks.push(() =>
      messagesService.removeListener(
        'thinking:chunk',
        onThinkingChunk as (...args: unknown[]) => void
      )
    );
    this.disposeCallbacks.push(() =>
      messagesService.removeListener('thinking:end', onThinkingEnd as (...args: unknown[]) => void)
    );
  }

  private async resync(): Promise<void> {
    if (this.disposed) return;
    try {
      const [session, tasks, queueResult] = await Promise.all([
        this.client.service('sessions').get(this.sessionId),
        this.client.service('tasks').findAll({
          query: {
            session_id: this.sessionId,
            $sort: { created_at: 1 },
          },
        }),
        this.client
          .service(`/sessions/${this.sessionId}/messages/queue`)
          .find()
          .catch(() => ({ data: [] }) as QueueFindResult),
      ]);

      let messagesByTask = this.stateSnapshot.messagesByTask;
      let loadedTaskIds = this.stateSnapshot.loadedTaskIds;

      if (this.options.taskHydration === 'eager') {
        const allMessages = await this.client.service('messages').findAll({
          query: {
            session_id: this.sessionId,
            $sort: { index: 1 },
          },
        });
        messagesByTask = groupMessagesByTask(allMessages);
        loadedTaskIds = new Set(messagesByTask.keys());
      } else if (this.stateSnapshot.loadedTaskIds.size > 0) {
        const refreshedByTask = new Map<string, Message[]>();
        for (const taskId of this.stateSnapshot.loadedTaskIds) {
          const taskMessages = await this.client.service('messages').findAll({
            query: {
              task_id: taskId,
              $sort: { index: 1 },
            },
          });
          refreshedByTask.set(taskId, sortMessagesByIndex(taskMessages));
        }
        messagesByTask = refreshedByTask;
        loadedTaskIds = new Set(refreshedByTask.keys());
      }

      this.updateState((prev) => ({
        ...prev,
        session,
        tasks,
        queuedMessages: sortMessagesByQueuePosition((queueResult as QueueFindResult).data || []),
        messagesByTask,
        loadedTaskIds,
        error: null,
        lastSyncedAt: new Date().toISOString(),
      }));
    } catch (error) {
      this.updateState((prev) => ({
        ...prev,
        error: error instanceof Error ? error.message : 'Failed to resync reactive session',
      }));
    }
  }
}

export interface ReactiveAgorClient extends AgorClient {
  session(sessionId: string, options?: ReactiveSessionOptions): ReactiveSessionHandle;
}

export function attachReactiveSessionApi(client: AgorClient): ReactiveAgorClient {
  const reactiveClient = client as ReactiveAgorClient;
  const target = reactiveClient as ReactiveAgorClient & {
    session?: (sessionId: string, options?: ReactiveSessionOptions) => ReactiveSessionHandle;
  };

  if (typeof target.session === 'function') {
    return reactiveClient;
  }

  target.session = (sessionId: string, options?: ReactiveSessionOptions) => {
    return new ReactiveSessionHandle(client, sessionId, options);
  };

  return reactiveClient;
}

function sortMessagesByIndex(messages: Message[]): Message[] {
  return [...messages].sort((a, b) => a.index - b.index);
}

function sortMessagesByQueuePosition(messages: Message[]): Message[] {
  return [...messages].sort((a, b) => (a.queue_position || 0) - (b.queue_position || 0));
}

function groupMessagesByTask(messages: Message[]): Map<string, Message[]> {
  const grouped = new Map<string, Message[]>();
  for (const message of messages) {
    if (!message.task_id) continue;
    const current = grouped.get(message.task_id) || [];
    current.push(message);
    grouped.set(message.task_id, current);
  }
  for (const [taskId, taskMessages] of grouped.entries()) {
    grouped.set(taskId, sortMessagesByIndex(taskMessages));
  }
  return grouped;
}
