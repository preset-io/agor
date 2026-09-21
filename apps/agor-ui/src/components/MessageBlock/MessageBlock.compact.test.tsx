import type { Message } from '@agor-live/client';
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { MessageBlock } from './MessageBlock';

const userMessage = {
  message_id: 'user-1',
  session_id: 'session-1',
  type: 'message',
  role: 'user',
  index: 0,
  timestamp: '2026-09-21T00:00:00.000Z',
  content: 'Fix the mobile loading skeletons',
  content_preview: 'Fix the mobile loading skeletons',
} as unknown as Message;

const editMessage = (withDiff: boolean) =>
  ({
    message_id: 'edit-1',
    session_id: 'session-1',
    type: 'message',
    role: 'assistant',
    index: 1,
    timestamp: '2026-09-21T00:00:10.000Z',
    content: [
      { type: 'tool_use', id: 'e1', name: 'Edit', input: { file_path: '/repo/Card.tsx' } },
      {
        type: 'tool_result',
        tool_use_id: 'e1',
        content: 'ok',
        ...(withDiff
          ? {
              diff: {
                structuredPatch: [
                  {
                    oldStart: 1,
                    oldLines: 1,
                    newStart: 1,
                    newLines: 2,
                    lines: ['-old', '+new', '+extra'],
                  },
                ],
              },
            }
          : {}),
      },
    ],
  }) as unknown as Message;

const contentBox = (container: HTMLElement) =>
  container.querySelector('.ant-bubble-content') as HTMLElement;

const revealCopyControl = (container: HTMLElement) => {
  fireEvent.mouseEnter(container.querySelector('.ant-bubble-content > div') as HTMLElement);
  return container.querySelector('.anticon-copy') as HTMLElement;
};

describe('compact user bubble', () => {
  it('pads evenly and keeps the copy control inside the bubble', () => {
    const { container } = render(<MessageBlock message={userMessage} compact />);
    const box = contentBox(container);

    expect(Number.parseFloat(box.style.paddingTop)).toBe(
      Number.parseFloat(box.style.paddingBottom)
    );

    // The control is pulled up out of the content box; it must still land
    // inside the bubble rather than over its top edge.
    const offset = Number.parseFloat(revealCopyControl(container).style.top);
    expect(Number.parseFloat(box.style.paddingTop) + offset).toBeGreaterThan(0);
  });

  it('leaves the detailed user bubble and its copy control alone', () => {
    const { container } = render(<MessageBlock message={userMessage} />);

    expect(contentBox(container).style.padding).toBe('');
    expect(revealCopyControl(container).style.top).toBe('-8px');
  });

  it('leaves the compact assistant bubble borderless and unpadded', () => {
    const { container } = render(
      <MessageBlock message={{ ...userMessage, role: 'assistant' } as Message} compact />
    );

    expect(contentBox(container).style.padding).toBe('');
    expect(revealCopyControl(container).style.top).toBe('-8px');
  });
});

describe('compact edit rows', () => {
  it('shows the change size without having to expand the row', () => {
    render(<MessageBlock message={editMessage(true)} compact />);

    expect(screen.getByText('+2')).toBeVisible();
    expect(screen.getByText('−1')).toBeVisible();
    // The diff itself is still one click away.
    expect(screen.queryByText('extra')).not.toBeInTheDocument();
  });

  it('shows nothing when the result carries no diff', () => {
    render(<MessageBlock message={editMessage(false)} compact />);

    expect(screen.queryByText('+2')).not.toBeInTheDocument();
    expect(screen.getByText('Edit')).toBeVisible();
  });

  it('adds no row stat in detailed, which already opens onto the diff', () => {
    render(<MessageBlock message={editMessage(true)} />);

    expect(screen.getByText('extra')).toBeVisible();
    // The only stat is the expanded diff's own header.
    expect(screen.getAllByText('+2')).toHaveLength(1);
  });
});
