import {
  type AgorClient,
  type Message,
  type MessageID,
  MessageRole,
  releaseReactiveSession,
  retainReactiveSession,
  type SessionID,
  type Task,
  type TaskID,
  TaskStatus,
} from '@agor-live/client';
import { createRoot } from 'react-dom/client';
import { ConversationView } from './ConversationView';

// Production-browser fixture: the real lean ReactiveSessionHandle, shared-session
// hook and ConversationView over a fake transport. The fake database keeps only
// turn numbers and mints fresh payloads per read, so it never retains one.
const SESSION_ID = '0199a000-0000-7000-8000-000000000000' as SessionID;
const PAYLOAD_BYTES = 256 * 1024;
const THINKING_BYTES = 64 * 1024;
const LEAN_TEXT_BYTES = 4 * 1024;
const taskId = (n: number) => `0199a000-0000-7000-8000-${String(n).padStart(12, '0')}` as TaskID;
let turns = 0;
let detailReadDelay = 0;
let mountedHandle = false;
/** Turns whose answer also edits a file: a default-open body beside the text. */
const editTurns = new Set<number>();
/** Turns whose answer has a table: Streamdown offers a portaled fullscreen viewer. */
const tableTurns = new Set<number>();
/** Turns whose answer carries a marked text payload: what lean history itself keeps. */
const leanTextTurns = new Set<number>();

function task(n: number, status: Task['status']): Task {
  const createdAt = new Date(Date.UTC(2026, 9, 1, 0, n)).toISOString();
  return {
    task_id: taskId(n),
    session_id: SESSION_ID,
    created_by: 'fixture-user',
    full_prompt: `Prompt ${n}`,
    status,
    created_at: createdAt,
    message_range: { start_index: n * 10, end_index: n * 10 + 2, start_timestamp: createdAt },
    git_state: { ref_at_start: 'main', sha_at_start: 'unknown' },
    recorded_tool_count: 1,
  } as Task;
}

function messages(n: number): Message[] {
  const base = {
    session_id: SESSION_ID,
    task_id: taskId(n),
    timestamp: task(n, TaskStatus.COMPLETED).created_at,
  };
  const prefix = `TRANSCRIPT_RETENTION_${n}_`;
  const thinking = `TRANSCRIPT_THINKING_${n}_`;
  const lean = `TRANSCRIPT_LEAN_${n}_`;
  return [
    {
      ...base,
      message_id: `${taskId(n)}-tool` as MessageID,
      index: n * 10,
      role: MessageRole.ASSISTANT,
      type: 'assistant',
      content_preview: '',
      content: [
        { type: 'tool_use', id: `read-${n}`, name: 'Read', input: { file_path: `/turn-${n}.txt` } },
      ],
    },
    {
      ...base,
      message_id: `${taskId(n)}-result` as MessageID,
      index: n * 10 + 1,
      role: MessageRole.USER,
      type: 'user',
      content_preview: '',
      // Materialize an independent flat string, not a rope sharing the prefix.
      content: [
        {
          type: 'tool_result',
          tool_use_id: `read-${n}`,
          content: JSON.parse(JSON.stringify(prefix + 'x'.repeat(PAYLOAD_BYTES - prefix.length))),
        },
      ],
    },
    {
      ...base,
      message_id: `${taskId(n)}-answer` as MessageID,
      index: n * 10 + 2,
      role: MessageRole.ASSISTANT,
      type: 'assistant',
      content_preview: '',
      // Reasoning beside visible text: the message stays mounted after eviction.
      content: [
        {
          type: 'thinking',
          text: JSON.parse(JSON.stringify(thinking + 'y'.repeat(THINKING_BYTES - thinking.length))),
        },
        {
          type: 'text',
          text: tableTurns.has(n)
            ? `Answer ${n}\n\n| Column | Value |\n| --- | --- |\n| row | TABLE_${n} |`
            : `Answer ${n}`,
        },
        ...(leanTextTurns.has(n)
          ? [
              {
                type: 'text',
                text: JSON.parse(
                  JSON.stringify(lean + 'z'.repeat(LEAN_TEXT_BYTES - lean.length))
                ) as string,
              },
            ]
          : []),
        ...(editTurns.has(n)
          ? [
              {
                type: 'tool_use',
                id: `edit-${n}`,
                name: 'Edit',
                input: {
                  file_path: `/edit-${n}.txt`,
                  old_string: 'before',
                  new_string: `TRANSCRIPT_EDIT_${n}`,
                },
              },
            ]
          : []),
      ],
    },
  ] as Message[];
}

const project = (message: Message): Message => ({
  ...message,
  content: Array.isArray(message.content)
    ? message.content.filter(
        (block) => !['tool_use', 'tool_result', 'thinking'].includes(block.type)
      )
    : message.content,
});

type Handler = (payload: unknown) => void;
function events() {
  const handlers = new Map<string, Set<Handler>>();
  return {
    on(event: string, handler: Handler) {
      if (!handlers.has(event)) handlers.set(event, new Set());
      handlers.get(event)!.add(handler);
    },
    off(event: string, handler: Handler) {
      handlers.get(event)?.delete(handler);
    },
    removeListener(event: string, handler: Handler) {
      handlers.get(event)?.delete(handler);
    },
    emit(event: string, payload?: unknown) {
      for (const handler of [...(handlers.get(event) ?? [])]) handler(payload);
    },
  };
}

const io = Object.assign(events(), { connected: true });
const tasks = Object.assign(events(), {
  find: async ({ query }: { query: { task_id?: { $lte?: string } } }) => {
    const rows = Array.from({ length: turns }, (_, n) => task(n, TaskStatus.COMPLETED))
      .filter((row) => !query.task_id?.$lte || row.task_id <= query.task_id.$lte)
      .reverse();
    return { data: rows, total: rows.length };
  },
  get: async (id: string) => task(Number(id.slice(-12)), TaskStatus.COMPLETED),
});
const messageService = Object.assign(events(), {
  findAll: async ({
    query,
  }: {
    query: { task_id: string | { $in: string[] }; transcript?: string };
  }) => {
    const ids = typeof query.task_id === 'string' ? [query.task_id] : query.task_id.$in;
    if (query.transcript !== 'lean' && detailReadDelay) {
      await new Promise((resolve) => setTimeout(resolve, detailReadDelay));
    }
    const rows = ids.flatMap((id) => messages(Number(id.slice(-12))));
    return query.transcript === 'lean' ? rows.map(project) : rows;
  },
});
const services: Record<string, unknown> = {
  sessions: Object.assign(events(), {
    get: async () => ({ session_id: SESSION_ID, tasks: [] }),
  }),
  tasks,
  messages: messageService,
  'session-streams': {
    create: async () => ({ session_id: SESSION_ID }),
    remove: async () => ({ session_id: SESSION_ID }),
  },
};
const queue = { find: async () => ({ data: [] }) };
const client = {
  io,
  service: (name: string) => (name.endsWith('/tasks/queue') ? queue : services[name]),
} as unknown as AgorClient;

const root = createRoot(document.getElementById('root')!);

export const fixture = {
  /** Like the opened-transcript prefetch: the reader binds an already-live handle. */
  async prehydrate() {
    await retainReactiveSession(client, SESSION_ID, { taskHydration: 'lean' }).ready();
  },
  /** Resolves once the view's handle has loaded, so live turns follow its snapshot. */
  async mount() {
    root.render(
      <div style={{ height: '100vh', display: 'flex', flexDirection: 'column' }}>
        <ConversationView client={client} sessionId={SESSION_ID} />
      </div>
    );
    // The view retains its shared handle in an effect that may not have run
    // yet. Share it now and hold the reference until unmount, so the handle
    // that loaded is the one receiving live turns.
    mountedHandle = true;
    await retainReactiveSession(client, SESSION_ID, { taskHydration: 'lean' }).ready();
  },
  /** One live turn as the daemon publishes it: created, payloads, completed. */
  addTurn({ edit = false, table = false, leanText = false } = {}) {
    const n = turns++;
    if (edit) editTurns.add(n);
    if (table) tableTurns.add(n);
    if (leanText) leanTextTurns.add(n);
    tasks.emit('created', task(n, TaskStatus.RUNNING));
    for (const message of messages(n)) messageService.emit('created', message);
    tasks.emit('patched', task(n, TaskStatus.COMPLETED));
    return taskId(n);
  },
  taskId,
  /** Hold full-detail reads open so the loading state can be observed. */
  delayDetailReads(ms: number) {
    detailReadDelay = ms;
  },
  unmount() {
    root.unmount();
    if (mountedHandle) releaseReactiveSession(client, SESSION_ID, { taskHydration: 'lean' });
    mountedHandle = false;
  },
};

// Keep the test driver local to this entry point, not in the app's Window type.
Object.assign(window, { transcriptRetentionFixture: fixture });
