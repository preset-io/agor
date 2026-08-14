import type {
  AgorClient,
  Message,
  Session,
  SessionPromptOptions,
  SessionPromptResult,
  Task,
} from '@agor/core/client';
import { MESSAGE_PAGINATION, PAGINATION, TaskStatus } from '@agor/core/client';

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
  /**
   * Queued tasks (status='queued'), ordered by queue_position ascending.
   * As of never-lose-prompt §C the queue lives on tasks instead of messages,
   * so this collection holds Task — not Message — and the wire format is the
   * `/sessions/:id/tasks/queue` endpoint.
   */
  queuedTasks: Task[];
  streamingMessages: ReactiveStreamingMessagesById;
  toolsByTask: ReactiveToolsByTask;
  loadedTaskIds: ReactiveLoadedTaskIds;
  connected: boolean;
  loading: boolean;
  error: string | null;
  /**
   * `true` when `error` represents a non-recoverable condition for this
   * session. Set when:
   *
   * - The server emits a `removed` event for this session (deleted /
   *   archived out of view).
   * - `resync()` fails with an HTTP **403** (forbidden — the user lost
   *   access) or **404** (not found — session no longer exists from this
   *   user's perspective).
   *
   * Callers driving auto-retry (visibilitychange, token refresh, manual
   * Reload) MUST check this flag before calling `resync()` again,
   * otherwise they will hammer a doomed endpoint on every focus change.
   *
   * Other failures — transient 401 (around-hook will refresh), 5xx, network
   * drops — leave this `false` so the standard retry paths can heal them.
   */
  terminal: boolean;
  lastSyncedAt: string | null;
}

type Listener = () => void;

type MessageMutation =
  | { sequence: number; kind: 'upsert'; message: Message }
  | { sequence: number; kind: 'remove'; message: Message };

type TaskMutation =
  | { sequence: number; kind: 'upsert'; task: Task }
  | { sequence: number; kind: 'remove'; task: Task };

interface QueueFindResult {
  data?: Task[];
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
  private messageMutationSequence = 0;
  private messageFetchTokenSequence = 0;
  // A DB snapshot and the realtime stream are two independently scheduled
  // deliveries. Journal mutations only while a snapshot is in flight, then
  // replay them over that snapshot so a late stale response cannot erase a
  // message that was already observed live (or resurrect a removed one).
  private readonly messageFetches = new Map<number, number>();
  private readonly messageMutations: MessageMutation[] = [];
  private taskMutationSequence = 0;
  private taskFetchTokenSequence = 0;
  private readonly taskFetches = new Map<number, number>();
  private readonly taskMutations: TaskMutation[] = [];
  private sessionMutationSequence = 0;

  /**
   * The canonical (full-UUID) session id. When this handle was constructed with
   * a short id / alias, incoming realtime events still carry the full UUID, so
   * event matching must accept it too. Learned from the subscribe ack and from
   * hydration (the fetched session row's `session_id` is always canonical); we
   * deliberately do NOT overwrite `sessionId`, which echoes back what the
   * caller passed (API calls resolve short ids server-side anyway).
   */
  private canonicalSessionId: string | null = null;

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
      queuedTasks: [],
      streamingMessages: new Map(),
      toolsByTask: new Map(),
      loadedTaskIds: new Set(),
      connected: !!client.io?.connected,
      loading: true,
      error: null,
      terminal: false,
      lastSyncedAt: null,
    };

    this.attachListeners();
    // Retain the shared per-connection stream subscription for this session and
    // AWAIT its ack BEFORE hydrating: a chunk arriving after the ack lands on
    // top of hydrated state, and anything earlier is captured by the hydration
    // itself — a viewer opening mid-stream can't fall into the gap where early
    // chunks arrive with no streaming state and get dropped. Reconnects apply
    // the same ordering via onSocketConnect (rooms are per-connection; a
    // reconnect is a new one).
    this.readyPromise = this.subscribeThenHydrate(
      retainSessionStream(this.client, this.sessionId),
      () => this.bootstrap()
    );
  }

  /**
   * Await the streaming subscription ack, then run the hydration step, so chunk
   * delivery and state hydration can't interleave into a lost-update gap. Used
   * on both attach (retain) and reconnect (re-subscribe) with the same ordering.
   */
  private async subscribeThenHydrate(
    subscribed: Promise<void>,
    hydrate: () => Promise<void>
  ): Promise<void> {
    await subscribed;
    // Learn the canonical id from the ack so events (full-UUID) arriving before
    // hydration completes already match — the mid-stream chunk case.
    const canonical = getCanonicalSessionId(this.client, this.sessionId);
    if (canonical) this.canonicalSessionId = canonical;
    if (this.disposed) return;
    await hydrate();
  }

  get sessionId(): string {
    return this.stateSnapshot.sessionId;
  }

  /**
   * True when a realtime event's session id belongs to this handle — matching
   * either the id the caller requested or the canonical id learned from the
   * subscribe ack / hydration. Events always carry the canonical (full-UUID)
   * id, so a short-id handle relies on the canonical match.
   */
  private matchesSession(id: string): boolean {
    return id === this.sessionId || id === this.canonicalSessionId;
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
    const fetchToken = this.beginMessageFetch();
    try {
      const snapshot = await this.fetchTaskMessagesAtHighWater(taskId);
      let committed = snapshot;
      this.updateState((prev) => {
        committed = this.reconcileMessageFetch(
          fetchToken,
          snapshot,
          (message) => message.task_id === taskId && this.matchesSession(message.session_id)
        );
        const nextByTask = new Map(prev.messagesByTask);
        nextByTask.set(taskId, committed);
        const nextLoaded = new Set(prev.loadedTaskIds);
        nextLoaded.add(taskId);
        return {
          ...prev,
          messagesByTask: nextByTask,
          loadedTaskIds: nextLoaded,
          lastSyncedAt: new Date().toISOString(),
        };
      });
      this.cancelMessageFetch(fetchToken);
      return committed;
    } catch (error) {
      this.cancelMessageFetch(fetchToken);
      throw error;
    }
  }

  private beginMessageFetch(): number {
    this.messageFetchTokenSequence += 1;
    this.messageFetches.set(this.messageFetchTokenSequence, this.messageMutationSequence);
    return this.messageFetchTokenSequence;
  }

  private recordMessageMutation(kind: 'upsert' | 'remove', message: Message): void {
    this.messageMutationSequence += 1;
    if (this.messageFetches.size > 0) {
      this.messageMutations.push({ sequence: this.messageMutationSequence, kind, message });
    }
  }

  private reconcileMessageFetch(
    fetchToken: number,
    snapshot: Message[],
    belongsToFetch: (message: Message) => boolean
  ): Message[] {
    const fetchSequence = this.messageFetches.get(fetchToken);
    if (fetchSequence === undefined) return sortMessagesByIndex(snapshot);
    const byId = new Map(snapshot.map((message) => [message.message_id, message]));
    for (const mutation of this.messageMutations) {
      if (mutation.sequence <= fetchSequence || !belongsToFetch(mutation.message)) continue;
      if (mutation.kind === 'remove') byId.delete(mutation.message.message_id);
      else byId.set(mutation.message.message_id, mutation.message);
    }
    return sortMessagesByIndex([...byId.values()]);
  }

  private cancelMessageFetch(fetchToken: number): void {
    this.messageFetches.delete(fetchToken);
    if (this.messageFetches.size === 0) {
      this.messageMutations.length = 0;
      return;
    }
    const oldestActiveFetch = Math.min(...this.messageFetches.values());
    const firstNeeded = this.messageMutations.findIndex(
      (mutation) => mutation.sequence > oldestActiveFetch
    );
    if (firstNeeded === -1) this.messageMutations.length = 0;
    else if (firstNeeded > 0) this.messageMutations.splice(0, firstNeeded);
  }

  private async fetchMessagesAtHighWater(query: Record<string, unknown>): Promise<Message[]> {
    // The shared client's exact-transcript findAll() contract walks an
    // immutable Message-ID high-water mark with keyset pages. Completeness no
    // longer depends on seeing the matching realtime event; the journal is
    // retained by the caller until this snapshot is committed to state.
    return this.client.service('messages').findAll({
      query: { ...query, $limit: MESSAGE_PAGINATION.MAX_LIMIT },
    });
  }

  private async fetchTaskMessagesAtHighWater(taskId: string): Promise<Message[]> {
    return this.fetchMessagesAtHighWater({ task_id: taskId, $sort: { index: 1 } });
  }

  private beginTaskFetch(): number {
    this.taskFetchTokenSequence += 1;
    this.taskFetches.set(this.taskFetchTokenSequence, this.taskMutationSequence);
    return this.taskFetchTokenSequence;
  }

  private recordTaskMutation(kind: 'upsert' | 'remove', task: Task): void {
    this.taskMutationSequence += 1;
    if (this.taskFetches.size > 0) {
      this.taskMutations.push({ sequence: this.taskMutationSequence, kind, task });
    }
  }

  private cancelTaskFetch(fetchToken: number): void {
    this.taskFetches.delete(fetchToken);
    if (this.taskFetches.size === 0) {
      this.taskMutations.length = 0;
      return;
    }
    const oldestActiveFetch = Math.min(...this.taskFetches.values());
    const firstNeeded = this.taskMutations.findIndex(
      (mutation) => mutation.sequence > oldestActiveFetch
    );
    if (firstNeeded === -1) this.taskMutations.length = 0;
    else if (firstNeeded > 0) this.taskMutations.splice(0, firstNeeded);
  }

  private reconcileTaskFetch(fetchToken: number, snapshot: Task[]): Task[] {
    const fetchSequence = this.taskFetches.get(fetchToken);
    if (fetchSequence === undefined) return sortTasksByCreatedAt(snapshot);
    const byId = new Map(snapshot.map((task) => [task.task_id, task]));
    for (const mutation of this.taskMutations) {
      if (mutation.sequence <= fetchSequence) continue;
      if (mutation.kind === 'remove') byId.delete(mutation.task.task_id);
      else byId.set(mutation.task.task_id, mutation.task);
    }
    return sortTasksByCreatedAt([...byId.values()]);
  }

  private async fetchTasksAtHighWater(): Promise<Task[]> {
    // Exact-Session findAll() is an ID high-water keyset scan in @agor/core.
    // The surrounding bootstrap/resync journal stays open through commit.
    return this.client.service('tasks').findAll({
      query: {
        session_id: this.sessionId,
        $sort: { created_at: 1, task_id: 1 },
        $limit: PAGINATION.MAX_LIMIT,
      },
    });
  }

  private async fetchSessionMessagesAtHighWater(): Promise<Message[]> {
    return this.fetchMessagesAtHighWater({
      session_id: this.sessionId,
      $sort: { index: 1 },
    });
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
    // Release this handle's refcount on the shared per-connection subscription.
    // The last handle for the session sends the actual `remove`; disposing one
    // of several handles must NOT evict the shared connection from the room and
    // kill the others' streams.
    releaseSessionStream(this.client, this.sessionId);
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

  private commitBootstrapState(args: {
    previous: ReactiveSessionState;
    fetchedSession: Session;
    sessionFetchSequence: number;
    taskFetchToken: number;
    taskSnapshot: Task[];
    queueResult: QueueFindResult;
    messageFetchToken: number | null;
    eagerMessageSnapshot: Message[] | null;
    lazyMessageSnapshot: { taskId: string; messages: Message[] } | null;
  }): ReactiveSessionState {
    const sessionChanged = this.sessionMutationSequence > args.sessionFetchSequence;
    if (sessionChanged && args.previous.session === null && args.previous.terminal) {
      return { ...args.previous, loading: false };
    }
    const session = sessionChanged ? args.previous.session : args.fetchedSession;
    const reconciledTasks = this.reconcileTaskFetch(args.taskFetchToken, args.taskSnapshot);
    const tasks = orderTasksBySession(reconciledTasks, session?.tasks);

    let messagesByTask = new Map<string, Message[]>();
    let loadedTaskIds = new Set<string>();
    if (args.eagerMessageSnapshot) {
      const messages =
        args.messageFetchToken === null
          ? args.eagerMessageSnapshot
          : this.reconcileMessageFetch(
              args.messageFetchToken,
              args.eagerMessageSnapshot,
              (message) => this.matchesSession(message.session_id)
            );
      messagesByTask = groupMessagesByTask(messages);
      loadedTaskIds = new Set(messagesByTask.keys());
    } else if (args.lazyMessageSnapshot) {
      const { taskId, messages: snapshot } = args.lazyMessageSnapshot;
      const messages =
        args.messageFetchToken === null
          ? snapshot
          : this.reconcileMessageFetch(
              args.messageFetchToken,
              snapshot,
              (message) => message.task_id === taskId && this.matchesSession(message.session_id)
            );
      messagesByTask.set(taskId, messages);
      loadedTaskIds.add(taskId);
    }

    const liveTaskIds = new Set<string>(tasks.map((task) => task.task_id));
    messagesByTask = new Map([...messagesByTask].filter(([taskId]) => liveTaskIds.has(taskId)));
    loadedTaskIds = new Set([...loadedTaskIds].filter((taskId) => liveTaskIds.has(taskId)));

    const queuedById = new Map(
      (args.queueResult.data ?? []).map((task) => [task.task_id, task] as const)
    );
    for (const task of tasks) {
      if (task.status === TaskStatus.QUEUED) queuedById.set(task.task_id, task);
      else queuedById.delete(task.task_id);
    }

    return {
      ...args.previous,
      session,
      tasks,
      messagesByTask,
      loadedTaskIds,
      // Repair task_id on any stream initialized from a chunk that arrived
      // before Tasks were hydrated (task_id was undefined then).
      streamingMessages: restampStreamingTaskIds(args.previous.streamingMessages, tasks),
      queuedTasks: sortTasksByQueuePosition([...queuedById.values()]),
      loading: false,
      error: null,
      lastSyncedAt: new Date().toISOString(),
    };
  }

  private async bootstrap(): Promise<void> {
    const taskFetchToken = this.beginTaskFetch();
    const sessionFetchSequence = this.sessionMutationSequence;
    let messageFetchToken: number | null = null;
    try {
      const [session, taskSnapshot, queueResult] = await Promise.all([
        this.client.service('sessions').get(this.sessionId),
        this.fetchTasksAtHighWater(),
        this.client
          .service(`/sessions/${this.sessionId}/tasks/queue`)
          .find()
          .catch(() => ({ data: [] }) as QueueFindResult),
      ]);

      // The fetched row's id is canonical even when we asked by short id — the
      // authoritative source for event matching.
      if (session?.session_id) this.canonicalSessionId = session.session_id;

      // Use journaled Tasks to choose the lazy target, but do not close the
      // journal yet. It stays live through every slower bootstrap request and
      // the final state commit below.
      const provisionalTasks = this.reconcileTaskFetch(taskFetchToken, taskSnapshot);
      let eagerMessageSnapshot: Message[] | null = null;
      let lazyMessageSnapshot: { taskId: string; messages: Message[] } | null = null;

      if (this.options.taskHydration === 'eager') {
        messageFetchToken = this.beginMessageFetch();
        eagerMessageSnapshot = await this.fetchSessionMessagesAtHighWater();
      } else if (this.options.taskHydration === 'lazy') {
        // The conversation view expands the latest non-queued task by default
        // and auto-scrolls to it. Hydrating that task's messages here — before
        // we flip loading:false so ready() resolves with them in place —
        // guarantees the scroll target exists in the first render, instead of
        // landing on a header placeholder while TaskBlock lazy-loads the
        // messages afterward.
        const latestTask = findLatestHydratableTask(provisionalTasks);
        if (latestTask) {
          messageFetchToken = this.beginMessageFetch();
          try {
            const latestMessages = await this.fetchTaskMessagesAtHighWater(latestTask.task_id);
            lazyMessageSnapshot = { taskId: latestTask.task_id, messages: latestMessages };
          } catch {
            this.cancelMessageFetch(messageFetchToken);
            messageFetchToken = null;
            // Non-fatal: leave the latest task unhydrated so the rest of
            // bootstrap still succeeds; TaskBlock will lazy-load it as before.
          }
        }
      }

      this.updateState((prev) =>
        this.commitBootstrapState({
          previous: prev,
          fetchedSession: session,
          sessionFetchSequence,
          taskFetchToken,
          taskSnapshot,
          queueResult: queueResult as QueueFindResult,
          messageFetchToken,
          eagerMessageSnapshot,
          lazyMessageSnapshot,
        })
      );
      this.cancelTaskFetch(taskFetchToken);
      if (messageFetchToken !== null) this.cancelMessageFetch(messageFetchToken);
    } catch (error) {
      this.cancelTaskFetch(taskFetchToken);
      if (messageFetchToken !== null) this.cancelMessageFetch(messageFetchToken);
      // Mirror doResync()'s terminal classification — a 403/404 on the
      // initial mount is just as "doomed to retry" as on reconnect, and
      // without this the UI's auto-retry loop would keep poking a deleted/
      // forbidden session on every focus change until the component
      // remounts.
      const status = errorStatusCode(error);
      const terminal = status === 403 || status === 404;
      this.updateState((prev) => ({
        ...prev,
        loading: false,
        error: error instanceof Error ? error.message : 'Failed to bootstrap reactive session',
        terminal: prev.terminal || terminal,
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
      // A reconnect is a new connection with no room membership. Await the
      // shared re-subscribe (deduped to one join per session across handles)
      // BEFORE resyncing — the same subscribe-then-hydrate ordering as attach,
      // so a chunk arriving after the join lands on top of the resynced state.
      this.readyPromise = this.subscribeThenHydrate(
        resubscribeSessionStream(this.client, this.sessionId),
        () => this.resync()
      );
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
      if (!this.matchesSession(session.session_id)) return;
      this.sessionMutationSequence += 1;
      this.updateState((prev) => ({
        ...prev,
        session,
        lastSyncedAt: new Date().toISOString(),
      }));
    };
    const onSessionRemoved = (session: Session) => {
      if (!this.matchesSession(session.session_id)) return;
      this.sessionMutationSequence += 1;
      this.updateState((prev) => ({
        ...prev,
        session: null,
        error: 'Session was removed',
        terminal: true,
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
      if (!this.matchesSession(task.session_id)) return;
      this.recordTaskMutation('upsert', task);
      this.updateState((prev) => {
        const tasks = prev.tasks.some((t) => t.task_id === task.task_id)
          ? prev.tasks
          : sortTasksByCreatedAt([...prev.tasks, task]);
        // Tasks can be born QUEUED (e.g. when the daemon auto-queues a prompt
        // because the session is busy) — track them in queuedTasks too.
        const queuedTasks =
          task.status === 'queued' && !prev.queuedTasks.some((t) => t.task_id === task.task_id)
            ? sortTasksByQueuePosition([...prev.queuedTasks, task])
            : prev.queuedTasks;
        return {
          ...prev,
          tasks,
          queuedTasks,
          lastSyncedAt: new Date().toISOString(),
        };
      });
    };
    const onTaskPatched = (task: Task) => {
      if (!this.matchesSession(task.session_id)) return;
      this.recordTaskMutation('upsert', task);
      this.updateState((prev) => {
        const index = prev.tasks.findIndex((t) => t.task_id === task.task_id);
        const nextTasks = index === -1 ? [...prev.tasks, task] : [...prev.tasks];
        if (index !== -1) {
          nextTasks[index] = task;
        }

        // Maintain queuedTasks: in if status='queued', out otherwise.
        const isQueued = task.status === 'queued';
        const inQueue = prev.queuedTasks.some((t) => t.task_id === task.task_id);
        let nextQueuedTasks = prev.queuedTasks;
        if (isQueued) {
          nextQueuedTasks = inQueue
            ? sortTasksByQueuePosition(
                prev.queuedTasks.map((t) => (t.task_id === task.task_id ? task : t))
              )
            : sortTasksByQueuePosition([...prev.queuedTasks, task]);
        } else if (inQueue) {
          nextQueuedTasks = prev.queuedTasks.filter((t) => t.task_id !== task.task_id);
        }

        return {
          ...prev,
          tasks: sortTasksByCreatedAt(nextTasks),
          queuedTasks: nextQueuedTasks,
          lastSyncedAt: new Date().toISOString(),
        };
      });
    };
    const onTaskRemoved = (task: Task) => {
      if (!this.matchesSession(task.session_id)) return;
      this.recordTaskMutation('remove', task);
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
          queuedTasks: prev.queuedTasks.filter((t) => t.task_id !== task.task_id),
          messagesByTask: nextByTask,
          loadedTaskIds: nextLoaded,
          toolsByTask: nextTools,
          lastSyncedAt: new Date().toISOString(),
        };
      });
    };
    // The daemon emits a custom 'queued' event in addition to the standard
    // 'created' event, so subscribers can distinguish "task entered the queue"
    // from "task was created but is already running". onTaskCreated handles
    // the queued state too as a safety net for clients that miss the event.
    const onTaskQueued = (task: Task) => onTaskCreated(task);

    tasksService.on('created', onTaskCreated);
    tasksService.on('patched', onTaskPatched);
    tasksService.on('updated', onTaskPatched);
    tasksService.on('removed', onTaskRemoved);
    tasksService.on('queued', onTaskQueued as (...args: unknown[]) => void);
    this.disposeCallbacks.push(() => tasksService.removeListener('created', onTaskCreated));
    this.disposeCallbacks.push(() => tasksService.removeListener('patched', onTaskPatched));
    this.disposeCallbacks.push(() => tasksService.removeListener('updated', onTaskPatched));
    this.disposeCallbacks.push(() => tasksService.removeListener('removed', onTaskRemoved));
    this.disposeCallbacks.push(() =>
      tasksService.removeListener('queued', onTaskQueued as (...args: unknown[]) => void)
    );

    const onToolStart = (event: ToolStartEvent) => {
      if (!this.matchesSession(event.session_id)) return;
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
      if (!this.matchesSession(event.session_id)) return;
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
      if (!this.matchesSession(message.session_id)) return;
      this.recordMessageMutation('upsert', message);
      this.updateState((prev) => {
        const nextStreaming = new Map(prev.streamingMessages);
        nextStreaming.delete(message.message_id);
        if (!message.task_id) {
          return {
            ...prev,
            streamingMessages: nextStreaming,
            lastSyncedAt: new Date().toISOString(),
          };
        }

        const shouldTrackMessages =
          this.options.taskHydration === 'eager' || prev.loadedTaskIds.has(message.task_id);

        if (!shouldTrackMessages) {
          return {
            ...prev,
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
          streamingMessages: nextStreaming,
          lastSyncedAt: new Date().toISOString(),
        };
      });
    };

    const onMessagePatched = (message: Message) => {
      const taskId = message.task_id;
      if (!this.matchesSession(message.session_id) || !taskId) return;
      this.recordMessageMutation('upsert', message);
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
      if (!this.matchesSession(message.session_id)) return;
      this.recordMessageMutation('remove', message);
      const taskId = message.task_id;
      this.updateState((prev) => {
        const nextStreaming = new Map(prev.streamingMessages);
        nextStreaming.delete(message.message_id);
        if (!taskId) {
          return {
            ...prev,
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
          streamingMessages: nextStreaming,
          messagesByTask: nextByTask,
          lastSyncedAt: new Date().toISOString(),
        };
      });
    };

    const onStreamingStart = (event: StreamingStartEvent) => {
      if (!this.matchesSession(event.session_id)) return;
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
      if (!this.matchesSession(event.session_id)) return;
      this.updateState((prev) => {
        const current = prev.streamingMessages.get(event.message_id);
        const nextStreaming = new Map(prev.streamingMessages);
        if (current) {
          nextStreaming.set(event.message_id, {
            ...current,
            content: current.content + event.chunk,
          });
        } else {
          // Attached or reconnected after streaming:start already fired: the
          // start event won't repeat, so initialize the stream from this chunk
          // instead of dropping it. Content begins here; earlier text arrives
          // when the message row lands at the next boundary (onMessageCreated
          // then clears this entry). task_id is inferred from the active task
          // so the live text groups under the right TaskBlock.
          nextStreaming.set(event.message_id, {
            message_id: event.message_id,
            session_id: event.session_id,
            task_id: findLatestHydratableTask(prev.tasks)?.task_id,
            role: 'assistant',
            content: event.chunk,
            thinkingContent: '',
            timestamp: new Date().toISOString(),
            isStreaming: true,
          });
        }
        return {
          ...prev,
          streamingMessages: nextStreaming,
        };
      });
    };

    const onStreamingEnd = (event: StreamingEndEvent) => {
      if (!this.matchesSession(event.session_id)) return;
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
      if (!this.matchesSession(event.session_id)) return;
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
      if (!this.matchesSession(event.session_id)) return;
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
      if (!this.matchesSession(event.session_id)) return;
      this.updateState((prev) => {
        const current = prev.streamingMessages.get(event.message_id);
        const nextStreaming = new Map(prev.streamingMessages);
        if (current) {
          nextStreaming.set(event.message_id, {
            ...current,
            isThinking: true,
            thinkingContent: (current.thinkingContent || '') + event.chunk,
          });
        } else {
          // Attached mid-thinking (a long thinking block, no start replay):
          // initialize from this chunk so live thinking renders under the
          // active task instead of being dropped.
          nextStreaming.set(event.message_id, {
            message_id: event.message_id,
            session_id: event.session_id,
            task_id: findLatestHydratableTask(prev.tasks)?.task_id,
            role: 'assistant',
            content: '',
            thinkingContent: event.chunk,
            timestamp: new Date().toISOString(),
            isStreaming: true,
            isThinking: true,
          });
        }
        return {
          ...prev,
          streamingMessages: nextStreaming,
        };
      });
    };

    const onThinkingEnd = (event: ThinkingEndEvent) => {
      if (!this.matchesSession(event.session_id)) return;
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

  /**
   * In-flight `resync()` promise, if any. Used to single-flight overlapping
   * callers (socket `connect`, visibilitychange, manual Reload) so a slow
   * failure cannot stomp on a later success and re-stamp a stale error.
   */
  private resyncInflight: Promise<void> | null = null;

  /**
   * Re-fetch session/tasks/queue (and loaded message buckets) from the daemon.
   *
   * Called automatically on socket `connect` events (see {@link attachListeners})
   * so a reconnect after sleep / network drop pulls fresh DB state. Also
   * exposed publicly so the UI can re-trigger hydration manually — e.g. a
   * "Reload" button on the conversation panel's error banner, or a
   * `visibilitychange` / token-refresh listener that wants to recover from a
   * sticky error without forcing the user to refresh the tab.
   *
   * Errors land in `state.error`; success clears it.
   *
   * Single-flighted: concurrent callers join the same in-flight promise rather
   * than racing one another. Without this, a slow failing fetch could land
   * after a faster successful fetch and overwrite the cleared error with a
   * stale one. Callers should still check `state.terminal` before re-calling
   * after a failure — see {@link ReactiveSessionState.terminal}.
   */
  async resync(): Promise<void> {
    if (this.disposed) return;
    if (this.resyncInflight) return this.resyncInflight;
    const promise = this.doResync();
    this.resyncInflight = promise;
    try {
      await promise;
    } finally {
      if (this.resyncInflight === promise) {
        this.resyncInflight = null;
      }
    }
  }

  private async doResync(): Promise<void> {
    const taskFetchToken = this.beginTaskFetch();
    const sessionFetchSequence = this.sessionMutationSequence;
    let messageFetchToken: number | null = null;
    try {
      const [session, taskSnapshot, queueResult] = await Promise.all([
        this.client.service('sessions').get(this.sessionId),
        this.fetchTasksAtHighWater(),
        this.client
          .service(`/sessions/${this.sessionId}/tasks/queue`)
          .find()
          .catch(() => ({ data: [] }) as QueueFindResult),
      ]);

      // The fetched row's id is canonical even when we asked by short id.
      if (session?.session_id) this.canonicalSessionId = session.session_id;

      const provisionalTasks = this.reconcileTaskFetch(taskFetchToken, taskSnapshot);
      let eagerMessageSnapshot: Message[] | null = null;
      let lazyMessageSnapshots: Map<string, Message[]> | null = null;

      if (this.options.taskHydration === 'eager') {
        messageFetchToken = this.beginMessageFetch();
        eagerMessageSnapshot = await this.fetchSessionMessagesAtHighWater();
      } else if (this.options.taskHydration === 'lazy') {
        // Preserve the bootstrap invariant across reconnect: the latest
        // (expanded / scroll-target) task must stay hydrated even if a new task
        // became the latest while disconnected, or bootstrap's hydration failed
        // and left loadedTaskIds empty.
        const latestId = findLatestHydratableTask(provisionalTasks)?.task_id;
        const toRefresh = new Set(this.stateSnapshot.loadedTaskIds);
        if (latestId) toRefresh.add(latestId);
        if (toRefresh.size > 0) {
          messageFetchToken = this.beginMessageFetch();
          lazyMessageSnapshots = new Map<string, Message[]>();
          for (const taskId of toRefresh) {
            const taskMessages = await this.fetchTaskMessagesAtHighWater(taskId);
            lazyMessageSnapshots.set(taskId, taskMessages);
          }
        }
      }

      if (this.disposed) {
        this.cancelTaskFetch(taskFetchToken);
        if (messageFetchToken !== null) this.cancelMessageFetch(messageFetchToken);
        return;
      }
      this.updateState((prev) => {
        const sessionChanged = this.sessionMutationSequence > sessionFetchSequence;
        if (sessionChanged && prev.session === null && prev.terminal) return prev;
        const committedSession = sessionChanged ? prev.session : session;
        const tasks = orderTasksBySession(
          this.reconcileTaskFetch(taskFetchToken, taskSnapshot),
          committedSession?.tasks
        );

        let messagesByTask = prev.messagesByTask;
        let loadedTaskIds = prev.loadedTaskIds;
        if (eagerMessageSnapshot) {
          const messages =
            messageFetchToken === null
              ? eagerMessageSnapshot
              : this.reconcileMessageFetch(messageFetchToken, eagerMessageSnapshot, (message) =>
                  this.matchesSession(message.session_id)
                );
          messagesByTask = groupMessagesByTask(messages);
          loadedTaskIds = new Set(messagesByTask.keys());
        } else if (lazyMessageSnapshots) {
          const refreshedByTask = new Map<string, Message[]>();
          for (const [taskId, snapshot] of lazyMessageSnapshots) {
            refreshedByTask.set(
              taskId,
              messageFetchToken === null
                ? sortMessagesByIndex(snapshot)
                : this.reconcileMessageFetch(
                    messageFetchToken,
                    snapshot,
                    (message) =>
                      message.task_id === taskId && this.matchesSession(message.session_id)
                  )
            );
          }
          messagesByTask = refreshedByTask;
          loadedTaskIds = new Set(refreshedByTask.keys());
        }

        const liveTaskIds = new Set<string>(tasks.map((task) => task.task_id));
        messagesByTask = new Map([...messagesByTask].filter(([taskId]) => liveTaskIds.has(taskId)));
        loadedTaskIds = new Set([...loadedTaskIds].filter((taskId) => liveTaskIds.has(taskId)));
        const queuedById = new Map(
          ((queueResult as QueueFindResult).data ?? []).map((task) => [task.task_id, task] as const)
        );
        for (const task of tasks) {
          if (task.status === TaskStatus.QUEUED) queuedById.set(task.task_id, task);
          else queuedById.delete(task.task_id);
        }

        return {
          ...prev,
          session: committedSession,
          tasks,
          queuedTasks: sortTasksByQueuePosition([...queuedById.values()]),
          messagesByTask,
          loadedTaskIds,
          streamingMessages: restampStreamingTaskIds(prev.streamingMessages, tasks),
          error: null,
          terminal: false,
          lastSyncedAt: new Date().toISOString(),
        };
      });
      this.cancelTaskFetch(taskFetchToken);
      if (messageFetchToken !== null) this.cancelMessageFetch(messageFetchToken);
    } catch (error) {
      this.cancelTaskFetch(taskFetchToken);
      if (messageFetchToken !== null) this.cancelMessageFetch(messageFetchToken);
      if (this.disposed) return;
      const status = errorStatusCode(error);
      // 403 (forbidden) and 404 (not found) mean this session is gone
      // from the user's perspective — retrying will keep failing. Mark
      // terminal so the UI stops auto-refetching on every focus change.
      // 401 is intentionally NOT terminal: the around-hook on the socket
      // client will refresh and the next retry can succeed.
      const terminal = status === 403 || status === 404;
      this.updateState((prev) => ({
        ...prev,
        error: error instanceof Error ? error.message : 'Failed to resync reactive session',
        terminal: prev.terminal || terminal,
      }));
    }
  }
}

/**
 * Best-effort HTTP status extraction for arbitrary errors thrown by the
 * Feathers client / fetch / socket transport. Mirrors the field-soup that
 * `apps/agor-ui`'s `authErrors.ts` walks, but inlined here to avoid a UI →
 * client cross-package dependency for what is just three property reads.
 */
function errorStatusCode(err: unknown): number | undefined {
  if (!err || typeof err !== 'object') return undefined;
  const e = err as { code?: unknown; statusCode?: unknown; status?: unknown };
  if (typeof e.code === 'number') return e.code;
  if (typeof e.statusCode === 'number') return e.statusCode;
  if (typeof e.status === 'number') return e.status;
  return undefined;
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

// --- Per-connection stream subscription registry ---------------------------
//
// A session-stream room membership is per socket CONNECTION, but several
// ReactiveSessionHandles (e.g. a board peek, an open panel, and a transcript,
// each with its own taskHydration) share ONE connection for the same session.
// If every handle sent its own `remove` on dispose, disposing any one would
// evict the shared connection from the room and silently kill the others'
// streams. So subscription is refcounted; a single shared op chain orders
// create/remove across handles (a late create from a disposing handle can't
// land after a newer handle's create), and on reconnect every still-wanted
// session re-subscribes exactly once.
//
// The room is keyed by the CANONICAL session id the daemon echoes from
// `create` — not the caller-supplied id — because deep-link URLs carry short
// ids while other surfaces use the full UUID, and both resolve to one room.
// Two mechanisms keep exactly ONE refcounted membership per (client, canonical
// room): (1) `keyToCanonical` re-keys/aliases an entry to the canonical id once
// its ack returns, so a later retain of either id form reuses it without a
// second `create`; (2) `roomWanters` counts the entries currently joined to a
// canonical room, so `remove` fires only when the LAST retainer across all id
// forms releases — even in the race where both forms subscribe before either
// ack lands (their entries merge, and the count still gates the single remove).

interface StreamSubscription {
  refCount: number;
  chain: Promise<void>;
  /** Canonical room id echoed by create; used so `remove` leaves the right room. */
  roomId: string | null;
  wantSubscribed: boolean;
  /** True once this entry has contributed +1 to `roomWanters[roomId]`. */
  joined: boolean;
  /** Set when this entry was folded into the canonical entry; its ops no-op. */
  superseded: boolean;
  /**
   * The re-subscribe op for the CURRENT connection, shared by every handle so a
   * reconnect re-subscribes each session exactly once. Reset to null on socket
   * disconnect so the next reconnect issues a fresh join.
   */
  reconnect: Promise<void> | null;
}

interface ClientStreamState {
  subs: Map<string, StreamSubscription>;
  /** Caller-supplied id (short or full) → canonical room id, learned from acks. */
  keyToCanonical: Map<string, string>;
  /** Canonical room id → count of entries currently joined to it. */
  roomWanters: Map<string, number>;
  disconnectHandler: (() => void) | null;
}

const CLIENT_STREAM_STATE = new WeakMap<AgorClient, ClientStreamState>();

function getClientStreamState(client: AgorClient): ClientStreamState {
  let state = CLIENT_STREAM_STATE.get(client);
  if (!state) {
    state = {
      subs: new Map(),
      keyToCanonical: new Map(),
      roomWanters: new Map(),
      disconnectHandler: null,
    };
    CLIENT_STREAM_STATE.set(client, state);
  }
  return state;
}

function resolveStreamKey(state: ClientStreamState, sessionId: string): string {
  return state.keyToCanonical.get(sessionId) ?? sessionId;
}

/**
 * The canonical session id the daemon echoed for a caller-supplied id, learned
 * from a `create` ack, or null if not yet known. Lets a short-id handle match
 * incoming events (which carry the full UUID) once its subscription is acked.
 */
function getCanonicalSessionId(client: AgorClient, sessionId: string): string | null {
  const state = CLIENT_STREAM_STATE.get(client);
  const canonical = state?.keyToCanonical.get(sessionId);
  return canonical && canonical !== sessionId ? canonical : null;
}

/** Serialize a create/remove op onto the subscription's shared chain. */
function runSubscriptionOp(sub: StreamSubscription, op: () => Promise<void>): Promise<void> {
  const next = sub.chain.then(op, op);
  sub.chain = next.then(
    () => undefined,
    () => undefined
  );
  return next;
}

async function createSubscription(
  client: AgorClient,
  sessionId: string,
  sub: StreamSubscription,
  key: string
): Promise<void> {
  // Released or folded before this op ran — nothing to join.
  if (!sub.wantSubscribed || sub.superseded) return;
  let canonical: string | undefined;
  try {
    const result = (await client.service('session-streams').create({ session_id: sessionId })) as
      | { session_id?: string }
      | undefined;
    canonical = typeof result?.session_id === 'string' ? result.session_id : undefined;
  } catch {
    // Deploy skew / access error: the daemon's owner fallback covers the
    // creator's own tabs, and access errors also surface via bootstrap/resync.
  }
  if (!canonical) return;

  const state = CLIENT_STREAM_STATE.get(client);
  if (!state) return;

  // Learn the mapping so future retains of either id form resolve to the room.
  state.keyToCanonical.set(sessionId, canonical);
  state.keyToCanonical.set(canonical, canonical);
  if (key !== canonical) state.keyToCanonical.set(key, canonical);

  // Normalize this entry onto the canonical id.
  let target = sub;
  if (key !== canonical && state.subs.get(canonical) !== sub) {
    const existing = state.subs.get(canonical);
    if (existing) {
      // Race: another id form already established the canonical entry. Fold
      // this entry's refcount into it and retire this one (its pending ops
      // no-op via `superseded`); both joined the same room, so the count is
      // taken from the canonical entry only.
      existing.refCount += sub.refCount;
      existing.wantSubscribed = existing.wantSubscribed || sub.wantSubscribed;
      sub.superseded = true;
      if (state.subs.get(key) === sub) state.subs.delete(key);
      target = existing;
    } else {
      if (state.subs.get(key) === sub) state.subs.delete(key);
      state.subs.set(canonical, sub);
    }
  }

  target.roomId = canonical;
  // The server-side join actually happened, so account for it even if the
  // entry was released mid-flight — the pending remove (enqueued after this
  // create) will then leave the room. Skipping this would leak the membership.
  if (!target.joined) {
    target.joined = true;
    state.roomWanters.set(canonical, (state.roomWanters.get(canonical) ?? 0) + 1);
  }
}

async function removeSubscription(client: AgorClient, sub: StreamSubscription): Promise<void> {
  if (sub.superseded) return;
  const state = CLIENT_STREAM_STATE.get(client);
  const roomId = sub.roomId;
  // Never joined (create failed / not yet acked): nothing to leave.
  if (!sub.joined || !roomId || !state) return;
  sub.joined = false;
  const remaining = (state.roomWanters.get(roomId) ?? 1) - 1;
  if (remaining > 0) {
    // Another id-form entry still wants the room — keep the membership.
    state.roomWanters.set(roomId, remaining);
    return;
  }
  state.roomWanters.delete(roomId);
  try {
    await client.service('session-streams').remove(roomId);
  } catch {
    // Ignore — socket teardown removes room membership regardless.
  }
}

// A reconnect is a new connection with no room membership. Reset each sub's
// re-subscribe token on disconnect so the next `resubscribeSessionStream` (one
// per session, driven by the handles' connect listeners) issues a fresh join.
function ensureStreamDisconnectHandler(client: AgorClient, state: ClientStreamState): void {
  if (state.disconnectHandler) return;
  const handler = () => {
    for (const sub of state.subs.values()) {
      sub.reconnect = null;
    }
  };
  state.disconnectHandler = handler;
  client.io.on('disconnect', handler);
}

function retainSessionStream(client: AgorClient, sessionId: string): Promise<void> {
  const state = getClientStreamState(client);
  const key = resolveStreamKey(state, sessionId);
  let sub = state.subs.get(key);
  if (!sub) {
    sub = {
      refCount: 0,
      chain: Promise.resolve(),
      roomId: null,
      wantSubscribed: false,
      joined: false,
      superseded: false,
      reconnect: null,
    };
    state.subs.set(key, sub);
  }
  const was = sub.refCount;
  sub.refCount += 1;
  sub.wantSubscribed = true;
  ensureStreamDisconnectHandler(client, state);
  // First attach (including re-attach while a prior remove is still draining on
  // the shared chain) enqueues the create; it lands after any pending remove.
  if (was === 0) {
    const target = sub;
    return runSubscriptionOp(target, () => createSubscription(client, sessionId, target, key));
  }
  return sub.chain;
}

/**
 * Re-subscribe a still-wanted session on reconnect and return the shared op
 * promise so the caller can await the join BEFORE resyncing. Deduped per
 * connection: the first handle to call it enqueues the create; every other
 * handle for the same session awaits the same promise (exactly one join).
 */
function resubscribeSessionStream(client: AgorClient, sessionId: string): Promise<void> {
  const state = CLIENT_STREAM_STATE.get(client);
  if (!state) return Promise.resolve();
  const key = resolveStreamKey(state, sessionId);
  const sub = state.subs.get(key);
  if (!sub?.wantSubscribed) return Promise.resolve();
  if (!sub.reconnect) {
    sub.reconnect = runSubscriptionOp(sub, () => createSubscription(client, sessionId, sub, key));
  }
  return sub.reconnect;
}

function releaseSessionStream(client: AgorClient, sessionId: string): void {
  const state = CLIENT_STREAM_STATE.get(client);
  if (!state) return;
  const key = resolveStreamKey(state, sessionId);
  const sub = state.subs.get(key);
  if (!sub || sub.refCount === 0) return;
  sub.refCount -= 1;
  if (sub.refCount > 0) return;
  sub.wantSubscribed = false;
  void runSubscriptionOp(sub, () => removeSubscription(client, sub)).then(() => {
    // Re-resolve the key: the create ack (which ran before this remove on the
    // shared chain) may have re-keyed the entry from the id we captured to its
    // canonical id — e.g. a short-id handle disposed before its ack. Consulting
    // the stale key would leave the entry (and the connect-handler lifecycle)
    // orphaned. Drop it only if nothing re-attached while the remove drained.
    const currentKey = resolveStreamKey(state, sessionId);
    if (sub.refCount === 0 && !sub.wantSubscribed && state.subs.get(currentKey) === sub) {
      state.subs.delete(currentKey);
      if (state.subs.size === 0 && state.disconnectHandler) {
        client.io.off('disconnect', state.disconnectHandler);
        state.disconnectHandler = null;
        CLIENT_STREAM_STATE.delete(client);
      }
    }
  });
}

/**
 * @internal Test-only: number of live stream-subscription registry entries for
 * a client (0 once the last release has torn the client's state down). Lets
 * tests assert the registry doesn't leak entries across re-key / dispose races.
 */
export function __streamSubscriptionCountForTest(client: AgorClient): number {
  return CLIENT_STREAM_STATE.get(client)?.subs.size ?? 0;
}

interface SharedReactiveSessionEntry {
  handle: ReactiveSessionHandle;
  refCount: number;
}

const SHARED_REACTIVE_SESSIONS = new WeakMap<AgorClient, Map<string, SharedReactiveSessionEntry>>();

function normalizeReactiveSessionOptions(
  options?: ReactiveSessionOptions
): Required<ReactiveSessionOptions> {
  return {
    taskHydration: options?.taskHydration ?? 'lazy',
  };
}

function getSharedSessionKey(sessionId: string, options: Required<ReactiveSessionOptions>): string {
  return `${sessionId}:${options.taskHydration}`;
}

/**
 * Retain a shared reactive session handle for a given client/session/options tuple.
 * The handle is reference-counted and disposed when the last caller releases it.
 */
export function retainReactiveSession(
  client: AgorClient,
  sessionId: string,
  options?: ReactiveSessionOptions
): ReactiveSessionHandle {
  const normalizedOptions = normalizeReactiveSessionOptions(options);
  const cacheKey = getSharedSessionKey(sessionId, normalizedOptions);

  let clientSessions = SHARED_REACTIVE_SESSIONS.get(client);
  if (!clientSessions) {
    clientSessions = new Map();
    SHARED_REACTIVE_SESSIONS.set(client, clientSessions);
  }

  const existing = clientSessions.get(cacheKey);
  if (existing) {
    existing.refCount += 1;
    return existing.handle;
  }

  const handle = new ReactiveSessionHandle(client, sessionId, normalizedOptions);
  clientSessions.set(cacheKey, { handle, refCount: 1 });
  return handle;
}

/**
 * Release a retained shared reactive session handle.
 * Disposes the underlying handle when ref count reaches zero.
 */
export function releaseReactiveSession(
  client: AgorClient,
  sessionId: string,
  options?: ReactiveSessionOptions
): void {
  const normalizedOptions = normalizeReactiveSessionOptions(options);
  const cacheKey = getSharedSessionKey(sessionId, normalizedOptions);
  const clientSessions = SHARED_REACTIVE_SESSIONS.get(client);
  if (!clientSessions) {
    return;
  }

  const entry = clientSessions.get(cacheKey);
  if (!entry) {
    return;
  }

  entry.refCount -= 1;
  if (entry.refCount <= 0) {
    entry.handle.dispose();
    clientSessions.delete(cacheKey);
  }

  if (clientSessions.size === 0) {
    SHARED_REACTIVE_SESSIONS.delete(client);
  }
}

/**
 * The task the conversation view expands (and scrolls to) by default: the last
 * task in the created_at-ascending list whose status isn't QUEUED. Queued tasks
 * have no messages yet, so they are never the hydration / scroll target.
 */
function findLatestHydratableTask(tasks: Task[]): Task | undefined {
  for (let i = tasks.length - 1; i >= 0; i--) {
    if (tasks[i].status !== TaskStatus.QUEUED) return tasks[i];
  }
  return undefined;
}

/**
 * Fill in task_id for streaming messages initialized from a chunk that arrived
 * before task state was hydrated (task_id left undefined). Once tasks are known
 * the latest hydratable task is the active one, so grouping repairs and the
 * live text renders under the right TaskBlock. Returns the same map reference
 * when nothing changed, to preserve downstream memoization.
 */
function restampStreamingTaskIds(
  streamingMessages: ReactiveStreamingMessagesById,
  tasks: Task[]
): ReactiveStreamingMessagesById {
  const activeTaskId = findLatestHydratableTask(tasks)?.task_id;
  if (!activeTaskId) return streamingMessages;
  let next = streamingMessages;
  for (const [id, message] of streamingMessages) {
    if (!message.task_id) {
      if (next === streamingMessages) next = new Map(streamingMessages);
      next.set(id, { ...message, task_id: activeTaskId });
    }
  }
  return next;
}

function sortMessagesByIndex(messages: Message[]): Message[] {
  return [...messages].sort(
    (a, b) => a.index - b.index || a.message_id.localeCompare(b.message_id)
  );
}

function sortTasksByCreatedAt(tasks: Task[]): Task[] {
  return [...tasks].sort(
    (a, b) =>
      new Date(a.created_at).getTime() - new Date(b.created_at).getTime() ||
      a.task_id.localeCompare(b.task_id)
  );
}

function orderTasksBySession(tasks: Task[], taskIds?: readonly string[]): Task[] {
  if (!taskIds || taskIds.length === 0) return sortTasksByCreatedAt(tasks);
  const byId = new Map<string, Task>(tasks.map((task) => [task.task_id, task]));
  const ordered: Task[] = [];
  for (const taskId of taskIds) {
    const task = byId.get(taskId);
    if (!task) continue;
    ordered.push(task);
    byId.delete(taskId);
  }
  // A Task can become visible just before the Session.tasks append is observed.
  // Keep it rather than dropping it; the next Session patch/resync supplies its
  // canonical position.
  ordered.push(...sortTasksByCreatedAt([...byId.values()]));
  return ordered;
}

function sortTasksByQueuePosition(tasks: Task[]): Task[] {
  return [...tasks].sort((a, b) => (a.queue_position || 0) - (b.queue_position || 0));
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
