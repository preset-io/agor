import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createClient } from '@agor/core/api';
import { generateId } from '@agor/core/db';
import type {
  BranchID,
  Message,
  MessageCreate,
  MessageID,
  MessagePatch,
  SessionID,
  TaskID,
} from '@agor/core/types';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type {
  BranchRepository,
  MessagesRepository,
  SessionRepository,
} from '../../db/feathers-repositories.js';
import { createGit } from '../../git/index.js';
import {
  EXECUTOR_REQUEST_DATA_BUDGET_BYTES,
  registerExecutorRequestSizeGuard,
  registerTerminalTaskAcknowledgementHook,
} from '../../services/feathers-client.js';
import { CodexTool } from './codex-tool.js';
import type { CodexStreamEvent } from './prompt-service.js';

// Only the provider is simulated. Enrichment, provider event handling, Feathers
// hooks and the receiving message service all execute their real code paths.
vi.mock('./prompt-service.js', () => ({ CodexPromptService: class {} }));

const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});
const byteSize = (data: unknown) => Buffer.byteLength(JSON.stringify(data), 'utf8');

describe('Codex full-message transcript budget', () => {
  it.each([true, false])(
    'persists huge inputs/enriched diffs and subsequent completion (start events: %s)',
    async (withStarts) => {
      const dir = await mkdtemp(path.join(tmpdir(), 'agor-transcript-budget-'));
      dirs.push(dir);
      await createGit(dir).git.init();
      const sessionId = generateId() as SessionID;
      const taskId = generateId() as TaskID;
      const branchId = generateId() as BranchID;
      const snapshot = JSON.stringify({ branches: [{ state: 'x'.repeat(480_750) }] });
      const file = path.join(dir, 'state.json');
      const hugeInput = {
        patch: `*** Begin Patch\n*** Add File: state.json\n+${snapshot.repeat(2)}\n*** End Patch`,
      };
      const originalInput = structuredClone(hugeInput);
      const editInput = { changes: [{ path: 'state.json', kind: 'add' }] };
      // Two original input copies + original result fit; adding a smaller,
      // source-bounded Write diff does not. Exercise provenance all the way
      // through real handler wrappers and the Feathers projection hook.
      const retainedInput = {
        file_path: 'synthetic.txt',
        content: 'w'.repeat(240_000),
        opaque: 'i'.repeat(50_000),
      };
      const retainedOutput = JSON.stringify({ exact: 'r'.repeat(200_000) });
      const retainedInputBefore = structuredClone(retainedInput);
      const writes: { method: string; data: MessageCreate | MessagePatch }[] = [];
      const stored = new Map<MessageID, Message>();
      const client = createClient('http://localhost:1', false);
      // Agor's public client types expose remote helpers rather than local
      // service registration; use Feathers' local transport seam for this test.
      const localClient = client as unknown as { use(path: string, service: object): void };
      const terminalAcknowledged = vi.fn();
      registerExecutorRequestSizeGuard(client);
      registerTerminalTaskAcknowledgementHook(client, terminalAcknowledged);
      localClient.use('messages', {
        async create(data: MessageCreate) {
          expect(byteSize(data)).toBeLessThanOrEqual(EXECUTOR_REQUEST_DATA_BUDGET_BYTES);
          expect(data.session_id).toBe(sessionId);
          expect(data.task_id).toBe(taskId);
          writes.push({ method: 'create', data: structuredClone(data) });
          const message = { ...data, message_id: data.message_id ?? (generateId() as MessageID) };
          stored.set(message.message_id, message);
          return message;
        },
        async patch(id: MessageID, data: MessagePatch) {
          expect(byteSize(data)).toBeLessThanOrEqual(EXECUTOR_REQUEST_DATA_BUDGET_BYTES);
          writes.push({ method: 'patch', data: structuredClone(data) });
          const previous = stored.get(id);
          if (!previous) throw new Error('Message not created before patch');
          const message = { ...previous, ...data };
          stored.set(id, message);
          return message;
        },
      });
      localClient.use('tasks', {
        async patch(_id: string, data: { status: string }) {
          return data;
        },
      });
      const messagesRepo = {
        findInitialUserMessagesByTaskId: vi.fn().mockResolvedValue([]),
        getNextIndexBySessionId: vi.fn().mockResolvedValue(0),
      } as unknown as MessagesRepository;
      const sessionsRepo = {
        findById: vi.fn().mockResolvedValue({ session_id: sessionId, branch_id: branchId }),
      } as unknown as SessionRepository;
      const branchesRepo = {
        findById: vi.fn().mockResolvedValue({ path: dir }),
      } as unknown as BranchRepository;
      const tool = new CodexTool(
        messagesRepo,
        sessionsRepo,
        undefined,
        branchesRepo,
        undefined,
        undefined,
        client.service('messages')
      );
      const promptService = {
        async *promptSessionStreaming(): AsyncGenerator<CodexStreamEvent> {
          if (withStarts)
            yield {
              type: 'tool_start',
              toolUse: { id: 'patch', name: 'apply_patch', input: hugeInput },
            };
          // Assert the persistence await has not changed the provider's arguments.
          expect(hugeInput).toEqual(originalInput);
          yield {
            type: 'tool_complete',
            toolUse: {
              id: 'patch',
              name: 'apply_patch',
              input: hugeInput,
              output: 'ok',
              status: 'completed',
            },
          };
          if (withStarts)
            yield {
              type: 'tool_start',
              toolUse: { id: 'edit', name: 'edit_files', input: editInput },
            };
          await writeFile(file, snapshot);
          yield {
            type: 'tool_complete',
            toolUse: { id: 'edit', name: 'edit_files', input: editInput, status: 'completed' },
          };
          yield {
            type: 'tool_complete',
            toolUse: {
              id: 'next',
              name: 'Read',
              input: { file_path: 'missing.txt' },
              output: 'not found',
              status: 'failed',
            },
          };
          yield {
            type: 'tool_complete',
            toolUse: {
              id: 'retention',
              name: 'Write',
              input: retainedInput,
              output: retainedOutput,
              status: 'completed',
            },
          };
          expect(retainedInput).toEqual(retainedInputBefore);
          yield {
            type: 'complete',
            threadId: '',
            content: [{ type: 'text', text: 'final response' }],
          };
        },
      };
      (tool as unknown as { promptService: typeof promptService }).promptService = promptService;
      try {
        const result = await tool.executePromptWithStreaming(sessionId, 'synthetic test', taskId);
        expect(result.wasStopped).toBe(false);
        const messages = [...stored.values()];
        const blocks = messages.flatMap((message) =>
          Array.isArray(message.content) ? message.content : []
        );
        const patch = blocks.find((block) => block.type === 'tool_use' && block.id === 'patch');
        expect(patch?.transcript_truncation?.input.original_bytes).toBe(byteSize(hugeInput));
        const edit = blocks.find(
          (block) => block.type === 'tool_result' && block.tool_use_id === 'edit'
        );
        // Real edit_files enrichment duplicates the first file's long JSON line
        // in both structuredPatch and files. The source byte cap omits it as a unit.
        expect(edit?.transcript_truncation?.diff.original_bytes).toBeGreaterThan(960_000);
        expect(edit).not.toHaveProperty('diff');
        expect(edit).toMatchObject({ content: '[completed]', is_error: false });
        expect(
          blocks.find((block) => block.type === 'tool_result' && block.tool_use_id === 'next')
        ).toMatchObject({ content: 'not found', is_error: true });
        const retainedMessage = messages.find((message) =>
          message.tool_uses?.some((use) => use.id === 'retention')
        );
        expect(retainedMessage?.tool_uses?.[0].input).toEqual(retainedInputBefore);
        expect(
          blocks.find((block) => block.type === 'tool_use' && block.id === 'retention')?.input
        ).toEqual(retainedInputBefore);
        const retainedResult = blocks.find((block) => block.tool_use_id === 'retention');
        expect(retainedResult?.content).toBe(retainedOutput);
        expect(JSON.parse(retainedResult?.content as string)).toEqual(JSON.parse(retainedOutput));
        expect(retainedResult?.diff).toBeUndefined();
        expect(Object.keys(retainedResult?.transcript_truncation ?? {})).toEqual(['diff']);
        expect(retainedResult?.transcript_truncation?.diff.original_bytes).toBeLessThan(256_000);
        expect(messages.at(-1)?.content).toEqual([{ type: 'text', text: 'final response' }]);
        expect(writes.filter((write) => write.method === 'patch')).toHaveLength(withStarts ? 2 : 0);
        expect(await readFile(file, 'utf8')).toBe(snapshot);
        expect(hugeInput).toEqual(originalInput);
        await client.service('tasks').patch(taskId, { status: 'completed' });
        expect(terminalAcknowledged).toHaveBeenCalledOnce();
      } finally {
        client.io.close();
      }
    }
  );
});
