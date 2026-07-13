import type { Message, ToolResultContentBlock } from '@agor-live/client';
import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { AgentChain } from './AgentChain';
import { MessageBlock } from './MessageBlock';
import { ToolUseRenderer } from './ToolUseRenderer';

const projection = {
  truncated: true as const,
  original_content_bytes: 1_000_000,
  persisted_content_bytes: 800_000,
};
const notice = 'Result truncated for transcript storage; showing 781.3 KB of 976.6 KB.';

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
      <ToolUseRenderer
        toolUse={{ type: 'tool_use', id: 'tool-1', name: 'UnknownTool', input: {} }}
        toolResult={projectedResult({ is_error: true })}
      />
    );
    expect(screen.getByText(notice)).toBeInTheDocument();
    const errorResult = screen.getByText(/HEAD/);
    expect(errorResult).toBeInTheDocument();
    expect(errorResult.parentElement?.style.background).not.toBe('');
    generic.unmount();

    render(
      <ToolUseRenderer
        toolUse={{
          type: 'tool_use',
          id: 'tool-1',
          name: 'Edit',
          input: { file_path: 'src/file.ts', old_string: 'old', new_string: 'new' },
        }}
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

  it('renders once for standalone MessageBlock and AgentChain result paths', () => {
    const standalone = message([projectedResult()]);
    const messageBlock = render(<MessageBlock message={standalone} />);
    expect(screen.getAllByText(notice)).toHaveLength(1);
    const boundedContent = screen.getByText(/HEAD/);
    expect(boundedContent).toBeInTheDocument();
    expect(boundedContent.closest('div[style*="position: relative"]')).not.toHaveTextContent(
      notice
    );
    messageBlock.unmount();

    render(<AgentChain messages={[standalone]} isTaskRunning={false} isLatest />);
    expect(screen.getAllByText(notice)).toHaveLength(1);
    expect(screen.getByText(/HEAD/)).toBeInTheDocument();
  });

  it('omits the notice from every result path and renders no running spinner after failure', () => {
    const completeResult = projectedResult({ transcript_projection: undefined });
    const generic = render(
      <ToolUseRenderer
        toolUse={{ type: 'tool_use', id: 'tool-1', name: 'UnknownTool', input: {} }}
        toolResult={completeResult}
      />
    );
    expect(screen.queryByText(/Result truncated for transcript storage/)).not.toBeInTheDocument();
    generic.unmount();

    const custom = render(
      <ToolUseRenderer
        toolUse={{
          type: 'tool_use',
          id: 'tool-1',
          name: 'Edit',
          input: { file_path: 'src/file.ts', old_string: 'old', new_string: 'new' },
        }}
        toolResult={completeResult}
      />
    );
    expect(screen.queryByText(/Result truncated for transcript storage/)).not.toBeInTheDocument();
    custom.unmount();

    const standalone = message([completeResult]);
    const messageBlock = render(<MessageBlock message={standalone} />);
    expect(screen.queryByText(/Result truncated for transcript storage/)).not.toBeInTheDocument();
    messageBlock.unmount();

    const { container } = render(
      <AgentChain
        messages={[
          message(
            [{ type: 'tool_use', id: 'tool-pending', name: 'UnknownTool', input: {} }],
            'assistant'
          ),
          message([
            {
              type: 'tool_result',
              tool_use_id: 'unrelated',
              content: 'complete result',
            },
          ]),
        ]}
        isTaskRunning={false}
        isLatest
      />
    );

    expect(screen.queryByText(/Result truncated for transcript storage/)).not.toBeInTheDocument();
    expect(container.querySelector('.ant-spin')).not.toBeInTheDocument();
  });
});
