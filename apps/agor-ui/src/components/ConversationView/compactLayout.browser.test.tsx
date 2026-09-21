import type { Message } from '@agor-live/client';
import { cleanup, fireEvent, render } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { MessageBlock } from '../MessageBlock/MessageBlock';
import { ThinkingBlock } from '../ThinkingBlock/ThinkingBlock';
import { ToolBlock } from '../ToolBlock';

afterEach(cleanup);

const USER_TEXT = 'Fix the mobile loading skeletons';

const message = (role: string, content: unknown) =>
  ({
    message_id: `m-${role}`,
    session_id: 'session-1',
    type: 'message',
    role,
    index: 0,
    timestamp: '2026-09-21T00:00:00.000Z',
    content,
    content_preview: '',
  }) as unknown as Message;

/**
 * Real layout, at every configured viewport including the phone: the compact
 * grid is only worth anything if the edges actually line up.
 */
describe('compact transcript grid', () => {
  it('starts every block type on the same content edge', () => {
    const { container } = render(
      <div style={{ width: '100%' }}>
        <MessageBlock message={message('assistant', 'A written answer.')} compact />
        <ThinkingBlock compact content="Reasoning about it." />
        <ToolBlock compact icon={<span>i</span>} name="Read">
          <span>output</span>
        </ToolBlock>
      </div>
    );

    const left = (element: Element | null) => element?.getBoundingClientRect().left;
    const answer = left(container.querySelector('.ant-bubble-content'));
    const labels = Array.from(container.querySelectorAll('strong')).map((el) => left(el));

    expect(labels.length).toBe(2); // thinking + tool
    for (const labelLeft of labels) {
      expect(labelLeft).toBeCloseTo(answer as number, 0);
    }
  });

  const userBubble = (compact: boolean) =>
    render(<MessageBlock message={message('user', USER_TEXT)} compact={compact} />).container;

  const markdownBlocks = (container: HTMLElement) =>
    Array.from(
      (container.querySelector('.inline-markdown') as HTMLElement).children
    ) as HTMLElement[];

  it('centers the compact user bubble text between its padding', () => {
    const container = userBubble(true);

    // Symmetric bubble padding is not enough on its own: the markdown's own
    // trailing block margin used to sit inside it and push the text up.
    const bubble = (
      container.querySelector('.ant-bubble-content') as HTMLElement
    ).getBoundingClientRect();
    const blocks = markdownBlocks(container);
    const last = blocks[blocks.length - 1];
    const top = blocks[0].getBoundingClientRect().top - bubble.top;
    const bottom = bubble.bottom - last.getBoundingClientRect().bottom;

    expect(Math.abs(top - bottom)).toBeLessThanOrEqual(1);
    expect(getComputedStyle(last).marginBottom).toBe('0px');
  });

  it('keeps the space between paragraphs of a multi-block message', () => {
    const { container } = render(
      <MessageBlock message={message('user', 'First thing.\n\nSecond thing.')} compact />
    );
    const blocks = markdownBlocks(container);

    expect(blocks).toHaveLength(2);
    expect(
      blocks[1].getBoundingClientRect().top - blocks[0].getBoundingClientRect().bottom
    ).toBeGreaterThan(0);
  });

  it('leaves the assistant bubble and detailed markdown on their own margins', () => {
    const { container: assistant } = render(
      <MessageBlock message={message('assistant', 'A written answer.')} compact />
    );

    expect(assistant.querySelector('.markdown-flush-outer-margins')).toBeNull();
    expect(userBubble(false).querySelector('.markdown-flush-outer-margins')).toBeNull();
  });

  it('keeps the compact user bubble copy control inside the bubble', () => {
    const container = userBubble(true);
    const bubble = container.querySelector('.ant-bubble-content') as HTMLElement;

    fireEvent.mouseEnter(bubble.firstElementChild as HTMLElement);
    const control = container.querySelector('.anticon-copy') as HTMLElement;

    expect(control.getBoundingClientRect().top).toBeGreaterThan(bubble.getBoundingClientRect().top);
  });
});
