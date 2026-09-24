import { generateId } from '@agor/core/ids/browser';
import { type Message, MessageRole, type Task, TaskStatus } from '@agor-live/client';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { ConfigProvider } from 'antd';
import { afterEach, expect, it, vi } from 'vitest';
import { userEvent } from 'vitest/browser';
import { TaskBlock } from './TaskBlock';

afterEach(cleanup);

it('keeps notice boundaries, grouped timestamp access, and keyboard usage access at real viewports', async () => {
  const task: Task = {
    task_id: generateId(),
    session_id: generateId(),
    created_by: '',
    full_prompt: '',
    status: TaskStatus.COMPLETED,
    created_at: '2026-09-01T00:00:00.000Z',
    git_state: { ref_at_start: 'main', sha_at_start: 'synthetic' },
    computed_context_window: 22,
    normalized_sdk_response: {
      contextWindowLimit: 100,
      tokenUsage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
    },
  } as Task;
  const message = (index: number, role: MessageRole, content: string): Message => ({
    message_id: generateId(),
    task_id: task.task_id,
    session_id: task.session_id,
    index,
    role,
    type: role === MessageRole.USER ? 'user' : 'assistant',
    timestamp: task.created_at,
    content_preview: content,
    content,
  });
  const notice = {
    ...message(1, MessageRole.SYSTEM, 'Separate notice'),
    type: 'system',
    metadata: { is_btw_result: true },
  } as Message;
  const { container } = render(
    <ConfigProvider theme={{ token: {} }}>
      <TaskBlock
        task={task}
        taskMessages={[
          message(0, MessageRole.USER, 'Prompt'),
          notice,
          message(2, MessageRole.ASSISTANT, 'First actual answer'),
          message(3, MessageRole.ASSISTANT, 'Continued answer'),
        ]}
        taskMessagesLoaded
        onLoadTaskMessages={vi.fn()}
      />
    </ConfigProvider>
  );

  expect(container.querySelectorAll('.ant-bubble-avatar .ant-avatar')).toHaveLength(2);
  expect(screen.getByText('First actual answer')).toBeVisible();
  const timestamp = screen.getByRole('button', { name: /Message 3 timestamp:.*Message index: 3/s });
  expect(timestamp.closest('.ant-bubble-avatar')).not.toBeNull();
  expect(timestamp.getBoundingClientRect().width).toBeGreaterThan(0);
  await act(async () => userEvent.hover(timestamp));
  await waitFor(() => expect(screen.getByRole('tooltip')).toHaveTextContent('Message index: 3'));
  act(() => timestamp.focus());
  expect(document.activeElement).toBe(timestamp);
  act(() => {
    timestamp.blur();
    fireEvent.mouseLeave(screen.getByLabelText('Turn and its metadata'));
  });

  const usage = screen.getByRole('button', {
    name: /Context window 22% used; show token breakdown/,
  });
  const tag = usage.querySelector('.ant-tag')!;
  const label = screen.getByTestId('turn-usage-label');
  await waitFor(() => expect(getComputedStyle(label).color).toBe(label.style.color));
  await waitFor(() => expect(getComputedStyle(tag).color).toBe(getComputedStyle(label).color));
  const restingColor = getComputedStyle(tag).color;
  act(() => usage.focus());
  await waitFor(() => expect(getComputedStyle(tag).color).not.toBe(restingColor));
  await waitFor(() => expect(getComputedStyle(tag).color).toBe(getComputedStyle(label).color));
  await act(async () => userEvent.keyboard('{Enter}'));
  expect(usage).toHaveAttribute('aria-expanded', 'true');
  await waitFor(() => expect(screen.getByText('Context Window Usage')).toBeVisible());
  await act(async () => userEvent.keyboard('{Escape}'));
  expect(usage).toHaveAttribute('aria-expanded', 'false');
  // Exercise the touch pointer path in the real browser, including the phone viewport.
  act(() => {
    usage.blur();
    const answer = screen.getByText('Continued answer');
    fireEvent.pointerDown(answer, { pointerType: 'touch', clientX: 20, clientY: 20 });
    fireEvent.pointerUp(answer, { pointerType: 'touch', clientX: 20, clientY: 20 });
  });
  expect(screen.getByLabelText('Turn metadata')).toHaveStyle({ visibility: 'visible' });
  await act(async () => userEvent.hover(usage));
  await waitFor(() => expect(usage).toHaveAttribute('aria-expanded', 'true'));
  expect(container.scrollWidth).toBeLessThanOrEqual(window.innerWidth);
});
