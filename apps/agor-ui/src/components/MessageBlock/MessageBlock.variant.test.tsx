import type { Message } from '@agor-live/client';
import { render } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { MessageBlock } from './MessageBlock';

const messageOf = (overrides: Partial<Message>): Message =>
  ({
    message_id: 'message-1',
    session_id: 'session-1',
    type: 'message',
    index: 0,
    timestamp: '2026-07-23T00:00:00.000Z',
    content: 'hello there',
    content_preview: 'hello there',
    ...overrides,
  }) as unknown as Message;

describe('MessageBlock bubble variant', () => {
  it('renders an agent message without a bubble outline', () => {
    const { container } = render(<MessageBlock message={messageOf({ role: 'assistant' })} />);
    const content = container.querySelector('.ant-bubble-content');

    expect(content).toHaveClass('ant-bubble-content-borderless');
    expect(content).not.toHaveClass('ant-bubble-content-outlined');
  });

  it('keeps the filled bubble for a user message', () => {
    const { container } = render(<MessageBlock message={messageOf({ role: 'user' })} />);
    const content = container.querySelector('.ant-bubble-content');

    expect(content).toHaveClass('ant-bubble-content-filled');
  });

  it('keeps the filled bubble for an agor callback message', () => {
    const { container } = render(
      <MessageBlock
        message={messageOf({
          role: 'assistant',
          metadata: { is_agor_callback: true },
        } as Partial<Message>)}
      />
    );
    const content = container.querySelector('.ant-bubble-content');

    expect(content).toHaveClass('ant-bubble-content-filled');
  });
});
