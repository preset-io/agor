import { generateId } from '@agor/core/ids/browser';
import {
  type ContentBlock,
  type Message,
  MessageRole,
  type Task,
  TaskStatus,
} from '@agor-live/client';
import { fireEvent, render, screen, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import {
  attachGeneratedDiff,
  GENERATED_DIFF_BUDGET_BYTES,
} from '../../../../../packages/executor/src/services/generated-diff';
import { projectMessageData } from '../../../../../packages/executor/src/services/tool-result-truncator';
import { groupMessagesIntoBlocks, TaskBlock } from './TaskBlock';

const timestamp = '2026-09-14T00:00:00.000Z';
const summary = 'Synthetic short summary';
const persist = (message: Message): Message =>
  JSON.parse(JSON.stringify(projectMessageData(message, 800_000)));

function fixture(content: string | ContentBlock[], extra: Partial<ContentBlock> = {}) {
  const task: Task = {
    task_id: generateId(),
    session_id: generateId(),
    created_by: '',
    full_prompt: 'Synthetic projection task',
    status: TaskStatus.COMPLETED,
    created_at: timestamp,
    message_range: { start_index: 0, end_index: 2, start_timestamp: timestamp },
    git_state: { ref_at_start: 'synthetic', sha_at_start: 'unknown' },
  };
  const call: Message = {
    message_id: generateId(),
    session_id: task.session_id,
    task_id: task.task_id,
    type: 'assistant',
    role: MessageRole.ASSISTANT,
    index: 0,
    timestamp,
    content_preview: '',
    content: [
      { type: 'tool_use', id: 'task-call', name: 'Task', input: { description: 'Synthetic Task' } },
    ],
    tool_uses: [{ id: 'task-call', name: 'Task', input: { description: 'Synthetic Task' } }],
  };
  const result = persist({
    ...call,
    message_id: generateId(),
    type: 'user',
    role: MessageRole.USER,
    index: 2,
    tool_uses: undefined,
    content: [{ type: 'tool_result', tool_use_id: 'task-call', content, ...extra }],
  });
  return { task, call, result };
}

function Harness({ task, messages }: { task: Task; messages: Message[] }) {
  return (
    <TaskBlock
      task={task}
      taskMessages={messages}
      taskMessagesLoaded
      onLoadTaskMessages={() => {}}
    />
  );
}

describe('TaskBlock persisted result projections (production grouping and renderers)', () => {
  it('carries source diff omission metadata through TaskBlock to the actual tool consumer', () => {
    const { task, call } = fixture('ok');
    const input = { file_path: 'synthetic.json', content: 'x'.repeat(300_000) };
    const blocks: ContentBlock[] = [
      { type: 'tool_use', id: 'write', name: 'Write', input },
      { type: 'tool_result', tool_use_id: 'write', content: 'Exact write result' },
    ];
    // Exercise the real source-cap/provenance helper without importing Node-heavy
    // filesystem/git enrichment into UI's filtered install. Executor tests cover
    // Write -> enrichment; this suite covers attachment -> projection -> consumer.
    const diff = {
      structuredPatch: [
        { oldStart: 1, oldLines: 0, newStart: 1, newLines: 1, lines: [`+${input.content}`] },
      ],
    };
    const originalBytes = Buffer.byteLength(JSON.stringify(diff));
    expect(Buffer.byteLength(JSON.stringify({ diff }))).toBeGreaterThan(
      GENERATED_DIFF_BUDGET_BYTES
    );
    attachGeneratedDiff(blocks[1], diff);
    expect(blocks[1].diff).toBeUndefined();
    expect(blocks[1].transcript_truncation).toEqual({ diff: { original_bytes: originalBytes } });
    const saved = persist({
      ...call,
      content: blocks,
      tool_uses: [{ id: 'write', name: 'Write', input }],
    });
    expect(saved.tool_uses?.[0].input).toEqual(input);
    expect((saved.content as ContentBlock[])[0].input).toEqual(input);
    expect((saved.content as ContentBlock[])[1].content).toBe('Exact write result');
    expect((saved.content as ContentBlock[])[1].transcript_truncation).toEqual({
      diff: { original_bytes: originalBytes },
    });
    expect(Buffer.byteLength(JSON.stringify(saved))).toBeLessThanOrEqual(800_000);
    render(<Harness task={task} messages={[saved]} />);
    fireEvent.click(screen.getByRole('button', { name: /1 tool call/ }));
    // Write opens by default; the omission must be visible without another toggle.
    expect(screen.getByRole('note')).toHaveTextContent('Transcript shortened: diff');
    expect(screen.getByRole('note')).toHaveTextContent('Diff too large to preview');
    expect(screen.getByRole('note')).not.toHaveTextContent('input (originally');
    expect(screen.getByText('Exact write result')).toBeVisible();
    expect(screen.getByText('Input parameters')).toBeVisible();
    fireEvent.click(screen.getByText('Write', { exact: true }));
    expect(screen.queryByRole('note')).not.toBeInTheDocument();
    fireEvent.click(screen.getByText('Write', { exact: true }));
    expect(screen.getByRole('note')).toHaveTextContent('Diff too large to preview');
  });

  it('discloses unavailable original Task input through the actual TaskBlock route', () => {
    const { task, call } = fixture('ok');
    const input = { description: 'Synthetic task', prompt: 'x'.repeat(500_000) };
    call.content = [{ type: 'tool_use', id: 'task-call', name: 'Task', input }];
    call.tool_uses = [{ id: 'task-call', name: 'Task', input }];
    const saved = persist(call);
    render(<Harness task={task} messages={[saved]} />);
    expect(screen.getByRole('note')).toHaveTextContent('Transcript shortened: input');
    expect(screen.getByRole('note')).toHaveTextContent(
      'Full data for these fields is unavailable in the saved transcript'
    );
    expect(screen.getByRole('note')).toHaveTextContent('execution was not changed');
    expect(call.tool_uses[0].input).toBe(input);
  });

  it.each(['array', 'string'] as const)(
    'discloses a projected Task %s result with the thought collapsed and expanded',
    (kind) => {
      const content =
        kind === 'array'
          ? [
              { type: 'text' as const, text: summary },
              { type: 'text' as const, text: 'x'.repeat(810_000) },
            ]
          : `${summary}\n${'x'.repeat(810_000)}`;
      const { task, call, result } = fixture(content);
      const originalBytes = Buffer.byteLength(JSON.stringify(content));
      expect(result.content).toEqual([
        expect.objectContaining({
          tool_use_id: 'task-call',
          transcript_truncation: { content: { original_bytes: originalBytes } },
        }),
      ]);
      // The parent Task call is a MessageBlock; its correlated result is NOT.
      expect(groupMessagesIntoBlocks([call, result])).toEqual([
        { type: 'message', message: call },
        { type: 'agent-chain', messages: [result] },
      ]);
      if (kind === 'array') {
        expect((result.content as ContentBlock[])[0].content).toEqual([
          content[0],
          expect.stringContaining('more items truncated'),
        ]);
      }
      render(<Harness task={task} messages={[call, result]} />);
      expect(screen.queryByRole('note')).not.toBeInTheDocument();
      fireEvent.click(screen.getByRole('button', { name: 'Reasoning' }));
      expect(screen.getByText(/Task \(Task\)/)).toBeVisible();
      const chain = screen.getByRole('note').closest('[data-conversation-block]')! as HTMLElement;
      const assertNotice = () => {
        expect(screen.getAllByRole('note')).toHaveLength(1);
        expect(within(chain).getByRole('note')).toBeVisible();
        expect(screen.getByRole('note')).toHaveTextContent(
          `content (originally ${originalBytes.toLocaleString()} serialized bytes)`
        );
        expect(screen.getByRole('note')).toHaveTextContent('execution was not changed');
        expect(screen.getByRole('note')).toHaveTextContent(
          'Full data for these fields is unavailable in the saved transcript'
        );
        expect(screen.getByRole('note')).toHaveTextContent('may not be valid JSON');
      };
      assertNotice();
      fireEvent.click(within(chain).getByText('Thinking', { exact: true }));
      assertNotice();
      expect(within(chain).getAllByText((text) => text.startsWith(summary)).length).toBeGreaterThan(
        0
      );
      fireEvent.click(within(chain).getByText('Thinking', { exact: true }));
      assertNotice();
      // Closing the whole chain hides both its result and notice; reopening restores one.
      fireEvent.click(within(chain).getByRole('button', { name: 'Reasoning' }));
      expect(screen.queryByRole('note')).not.toBeInTheDocument();
      fireEvent.click(within(chain).getByRole('button', { name: 'Reasoning' }));
      assertNotice();
    }
  );

  it('retains a metadata-only Task result when enrichment was omitted and text is empty', () => {
    const diff = {
      structuredPatch: [
        { oldStart: 1, oldLines: 1, newStart: 1, newLines: 1, lines: ['x'.repeat(810_000)] },
      ],
    };
    const { task, call, result } = fixture('', { diff });
    render(<Harness task={task} messages={[call, result]} />);
    fireEvent.click(screen.getByRole('button', { name: 'Reasoning' }));
    expect(screen.getByRole('note')).toHaveTextContent(
      `diff (originally ${Buffer.byteLength(JSON.stringify(diff)).toLocaleString()} serialized bytes)`
    );
    expect(screen.getByRole('note')).not.toHaveTextContent('content (originally');
    expect(screen.getByRole('note')).toHaveTextContent('Diff too large to preview');
  });

  it('does not disclose shortening for an intact Task result', () => {
    const { task, call, result } = fixture([{ type: 'text', text: summary }]);
    render(<Harness task={task} messages={[call, result]} />);
    fireEvent.click(screen.getByRole('button', { name: 'Reasoning' }));
    fireEvent.click(screen.getByText('Thinking', { exact: true }));
    expect(screen.getAllByText(summary).length).toBeGreaterThan(0);
    expect(screen.queryByRole('note')).not.toBeInTheDocument();
  });

  it('keeps nested paired-result disclosure with its tool renderer, without a second thought notice', () => {
    const { task, call, result } = fixture(summary);
    const nestedCall: Message = {
      ...call,
      message_id: generateId(),
      index: 1,
      parent_tool_use_id: 'task-call',
      content: [
        {
          type: 'tool_use',
          id: 'nested-call',
          name: 'Read',
          input: { file_path: 'synthetic.txt' },
        },
      ],
      tool_uses: [{ id: 'nested-call', name: 'Read', input: { file_path: 'synthetic.txt' } }],
    };
    const nestedResult = persist({
      ...nestedCall,
      message_id: generateId(),
      type: 'user',
      role: MessageRole.USER,
      tool_uses: undefined,
      content: [
        {
          type: 'tool_result',
          tool_use_id: 'nested-call',
          content: [
            { type: 'text', text: 'Nested synthetic summary' },
            { type: 'text', text: 'x'.repeat(810_000) },
          ],
          is_error: true,
        },
      ],
    });
    expect(groupMessagesIntoBlocks([call, nestedCall, nestedResult, result])).toEqual([
      { type: 'message', message: call },
      { type: 'agent-chain', messages: [nestedCall, nestedResult, result] },
    ]);
    render(<Harness task={task} messages={[call, nestedCall, nestedResult, result]} />);
    fireEvent.click(screen.getByRole('button', { name: /1 tool call/ }));
    expect(screen.queryByRole('note')).not.toBeInTheDocument();
    // Do not expose a second shortened result preview while its owning tool
    // (and notice) is collapsed. The intact outer Task thought remains.
    expect(screen.queryByText('Nested synthetic summary')).not.toBeInTheDocument();
    expect(screen.getAllByText('Thinking', { exact: true })).toHaveLength(1);
    fireEvent.click(screen.getByText('Read', { exact: true }));
    expect(screen.getAllByRole('note')).toHaveLength(1);
    expect(screen.getAllByText('Nested synthetic summary')).toHaveLength(1);
    expect(screen.getByRole('note')).toHaveTextContent('Transcript shortened: content');
    for (const thought of screen.getAllByText('Thinking', { exact: true }))
      fireEvent.click(thought);
    expect(screen.getAllByRole('note')).toHaveLength(1);
    expect(screen.getByText('synthetic.txt', { exact: true })).toBeVisible();
  });
});
