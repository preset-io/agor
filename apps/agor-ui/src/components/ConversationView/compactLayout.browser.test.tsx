import type { Message } from '@agor-live/client';
import { cleanup, fireEvent, render } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { MessageBlock } from '../MessageBlock/MessageBlock';
import { ThinkingBlock } from '../ThinkingBlock/ThinkingBlock';
import { ToolBlock } from '../ToolBlock';

afterEach(cleanup);

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

  it('keeps the compact user bubble balanced with its copy control inside it', () => {
    const { container } = render(
      <MessageBlock message={message('user', 'Fix the mobile loading skeletons')} compact />
    );

    const bubble = container.querySelector('.ant-bubble-content') as HTMLElement;
    const style = getComputedStyle(bubble);
    expect(style.paddingTop).toBe(style.paddingBottom);

    fireEvent.mouseEnter(bubble.firstElementChild as HTMLElement);
    const control = container.querySelector('.anticon-copy') as HTMLElement;

    expect(control.getBoundingClientRect().top).toBeGreaterThan(bubble.getBoundingClientRect().top);
  });
});
