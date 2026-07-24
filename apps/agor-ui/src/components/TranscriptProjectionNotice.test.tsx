import {
  type Message,
  type Task,
  TaskStatus,
  type ToolResultContentBlock,
  type ToolUse,
} from '@agor-live/client';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { AgentChain } from './AgentChain';
import { MessageBlock } from './MessageBlock';
import { TaskBlock } from './TaskBlock';
import { ToolUseRenderer } from './ToolUseRenderer';

const projection = {
  truncated: true as const,
  original_content_bytes: 1_000_000,
  persisted_content_bytes: 800_000,
};
const notice =
  'Transcript storage retained 781.3 KB of 976.6 KB; the agent received the complete result.';
const genericToolUse: ToolUse = { id: 'tool-1', name: 'UnknownTool', input: {} };
const editToolUse: ToolUse = {
  id: 'tool-1',
  name: 'Edit',
  input: { file_path: 'src/file.ts', old_string: 'old', new_string: 'new' },
};

function projectedResult(overrides: Partial<ToolResultContentBlock> = {}): ToolResultContentBlock {
  return {
    type: 'tool_result',
    tool_use_id: 'tool-1',
    content: 'HEAD\n[Middle omitted from transcript storage]\nTAIL',
    transcript_projection: projection,
    ...overrides,
  };
}

function message(content: Message['content'], role: 'assistant' | 'user' = 'user'): Message {
  return {
    message_id: '018f0000-0000-7000-8000-000000000001',
    session_id: '018f0000-0000-7000-8000-000000000002',
    task_id: '018f0000-0000-7000-8000-000000000003',
    type: role,
    role,
    index: 0,
    timestamp: '2026-07-13T12:00:00.000Z',
    content_preview: '',
    content,
  } as Message;
}

describe('transcript projection notice', () => {
  it('renders the same notice around generic and custom tool results without hiding content or diff state', () => {
    const generic = render(
      <ToolUseRenderer toolUse={genericToolUse} toolResult={projectedResult({ is_error: true })} />
    );
    expect(screen.getByText(notice)).toBeInTheDocument();
    const errorResult = screen.getByText(/HEAD/);
    expect(errorResult).toBeInTheDocument();
    expect(errorResult.parentElement?.style.background).not.toBe('');
    generic.unmount();

    render(
      <ToolUseRenderer
        toolUse={editToolUse}
        toolResult={projectedResult({
          diff: {
            structuredPatch: [
              { oldStart: 1, oldLines: 1, newStart: 1, newLines: 1, lines: ['-old', '+new'] },
            ],
          },
        })}
      />
    );
    expect(screen.getByText(notice)).toBeInTheDocument();
    expect(screen.getByText('Update')).toBeInTheDocument();
    expect(screen.getByText('old')).toBeInTheDocument();
    expect(screen.getByText('new')).toBeInTheDocument();
  });

  it('copies a standalone projected result without the adjacent notice', async () => {
    const standalone = message([projectedResult()]);
    if (!navigator.clipboard?.writeText) {
      Object.defineProperty(navigator, 'clipboard', {
        configurable: true,
        value: { writeText: vi.fn() },
      });
    }
    const writeText = vi.spyOn(navigator.clipboard, 'writeText').mockResolvedValue(undefined);

    const messageBlock = render(<MessageBlock message={standalone} />);
    expect(screen.getAllByText(notice)).toHaveLength(1);
    const boundedContent = screen.getByText(/HEAD/);
    expect(boundedContent).toBeInTheDocument();
    const copyable = boundedContent.closest('div[style*="position: relative"]');
    expect(copyable).not.toHaveTextContent(notice);
    fireEvent.mouseEnter(copyable!);
    fireEvent.click(screen.getByRole('img', { name: 'copy' }));
    await waitFor(() => expect(writeText).toHaveBeenCalledWith(String(projectedResult().content)));
    expect(writeText.mock.calls[0][0]).not.toContain(notice);
    messageBlock.unmount();
    writeText.mockRestore();
  });

  it('renders once for standalone MessageBlock and AgentChain result paths', () => {
    const standalone = message([projectedResult()]);
    render(<AgentChain messages={[standalone]} isTaskRunning={false} isLatest />);
    expect(screen.getAllByText(notice)).toHaveLength(1);
    expect(screen.getByText(/HEAD/)).toBeInTheDocument();
  });

  it('omits the notice from every result path', () => {
    const completeResult = projectedResult({ transcript_projection: undefined });
    const generic = render(
      <ToolUseRenderer toolUse={genericToolUse} toolResult={completeResult} />
    );
    expect(screen.queryByText(notice)).not.toBeInTheDocument();
    generic.unmount();

    const custom = render(<ToolUseRenderer toolUse={editToolUse} toolResult={completeResult} />);
    expect(screen.queryByText(notice)).not.toBeInTheDocument();
    custom.unmount();

    const standalone = message([completeResult]);
    const messageBlock = render(<MessageBlock message={standalone} />);
    expect(screen.queryByText(notice)).not.toBeInTheDocument();
    messageBlock.unmount();

    render(
      <AgentChain
        messages={[
          message(
            [{ type: 'tool_use', id: 'tool-complete', name: 'UnknownTool', input: {} }],
            'assistant'
          ),
          message([
            {
              type: 'tool_result',
              tool_use_id: 'tool-complete',
              content: 'complete result',
            },
          ]),
        ]}
        isLatest
      />
    );

    expect(screen.queryByText(notice)).not.toBeInTheDocument();
  });

  it('derives terminal tool state from a failed task without a pending spinner', () => {
    const failedTask = {
      task_id: '018f0000-0000-7000-8000-000000000003',
      session_id: '018f0000-0000-7000-8000-000000000002',
      status: TaskStatus.FAILED,
      full_prompt: 'Exercise executor failure convergence',
      error_message: 'socket has been disconnected',
      tool_use_count: 1,
      created_at: '2026-07-13T12:00:00.000Z',
      completed_at: '2026-07-13T12:00:01.000Z',
      git_state: { ref_at_start: 'main', sha_at_start: 'abc' },
      message_range: {
        start_index: 0,
        end_index: 0,
        start_timestamp: '2026-07-13T12:00:00.000Z',
      },
    } as Task;
    const pendingTool = message(
      [{ type: 'tool_use', id: 'tool-pending', name: 'UnknownTool', input: {} }],
      'assistant'
    );

    const { container } = render(
      <TaskBlock
        task={failedTask}
        isExpanded
        onExpandChange={() => {}}
        taskMessages={[pendingTool]}
        taskMessagesLoaded
        onLoadTaskMessages={() => {}}
        onUnloadTaskMessages={() => {}}
        isLatestTask
      />
    );

    expect(container.querySelector('.ant-spin')).not.toBeInTheDocument();
  });
});
