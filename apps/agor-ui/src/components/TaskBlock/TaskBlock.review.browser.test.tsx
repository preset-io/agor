import { generateId } from '@agor/core/ids/browser';
import { type Message, MessageRole, type Task, TaskStatus } from '@agor-live/client';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { ConfigProvider } from 'antd';
import { afterEach, expect, it, vi } from 'vitest';
import { userEvent } from 'vitest/browser';
import { IDENTITY_AVATAR_SIZE } from '../../constants/ui';
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
        isLatestTask
        taskMessages={[
          message(0, MessageRole.USER, 'Prompt'),
          notice,
          message(2, MessageRole.ASSISTANT, 'First actual answer'),
          message(3, MessageRole.ASSISTANT, 'Continued answer'),
          message(4, MessageRole.ASSISTANT, 'One more answer'),
        ]}
        taskMessagesLoaded
        onLoadTaskMessages={vi.fn()}
      />
    </ConfigProvider>
  );

  expect(container.querySelectorAll('.ant-bubble-avatar .ant-avatar')).toHaveLength(2);
  expect(screen.getByText('First actual answer')).toBeVisible();
  const timestamp = screen.getByRole('button', { name: /Message 3 timestamp:.*Message index: 3/s });
  const nextTimestamp = screen.getByRole('button', {
    name: /Message 4 timestamp:.*Message index: 4/s,
  });
  expect(timestamp.closest('.ant-bubble-avatar')).not.toBeNull();
  expect(timestamp).toHaveClass('ant-btn');
  expect(timestamp.querySelector('.anticon-clock-circle')).not.toBeNull();
  expect(timestamp.getBoundingClientRect().width).toBe(IDENTITY_AVATAR_SIZE);
  expect(nextTimestamp.closest('.ant-bubble-avatar')).not.toBeNull();
  await act(async () => userEvent.hover(timestamp));
  await waitFor(() => expect(screen.getByRole('tooltip')).toHaveTextContent('Message index: 3'));
  await act(async () => userEvent.unhover(timestamp));
  await waitFor(() => expect(screen.queryByRole('tooltip')).not.toBeInTheDocument());
  act(() => timestamp.focus());
  expect(document.activeElement).toBe(timestamp);
  await waitFor(() => expect(screen.getByRole('tooltip')).toHaveTextContent('Message index: 3'));
  await act(async () => userEvent.keyboard('{Escape}'));
  await waitFor(() => expect(screen.queryByRole('tooltip')).not.toBeInTheDocument());
  await act(async () => userEvent.keyboard('{Enter}'));
  await waitFor(() => expect(screen.getByRole('tooltip')).toHaveTextContent('Message index: 3'));
  await act(async () => userEvent.keyboard('{Escape}'));
  await waitFor(() => expect(screen.queryByRole('tooltip')).not.toBeInTheDocument());
  await act(async () => userEvent.keyboard(' '));
  await waitFor(() => expect(screen.getByRole('tooltip')).toHaveTextContent('Message index: 3'));
  act(() => {
    timestamp.blur();
  });
  await act(async () => userEvent.click(nextTimestamp));
  await waitFor(() => expect(screen.getByRole('tooltip')).toHaveTextContent('Message index: 4'));
  act(() => nextTimestamp.blur());

  const usage = screen.getByRole('button', {
    name: /Context window 22% used; show token breakdown/,
  });
  const tag = usage.querySelector('.ant-tag')!;
  const label = screen.getByTestId('turn-usage-label');
  expect(getComputedStyle(label).color).toBe(label.style.color);
  expect(getComputedStyle(tag).color).toBe(label.style.color);
  expect(usage).toHaveClass('ant-btn');
  await act(async () => userEvent.keyboard('{Tab}'));
  act(() => usage.focus());
  expect(usage).toHaveFocus();
  expect(getComputedStyle(usage).outlineStyle).not.toBe('none');
  expect(getComputedStyle(tag).color).toBe(label.style.color);
  await act(async () => userEvent.keyboard('{Enter}'));
  expect(usage).toHaveAttribute('aria-expanded', 'true');
  await waitFor(() => expect(screen.getByText('Context Window Usage')).toBeVisible());
  await act(async () => userEvent.keyboard('{Escape}'));
  expect(usage).toHaveAttribute('aria-expanded', 'false');
  // Metadata remains visible after touching ordinary answer text.
  act(() => {
    usage.blur();
    const answer = screen.getByText('Continued answer');
    fireEvent.pointerDown(answer, { pointerType: 'touch', clientX: 20, clientY: 20 });
    fireEvent.pointerUp(answer, { pointerType: 'touch', clientX: 20, clientY: 20 });
  });
  expect(screen.getByLabelText('Turn metadata')).toBeVisible();
  await act(async () => userEvent.hover(usage));
  await waitFor(() => expect(usage).toHaveAttribute('aria-expanded', 'true'));
  expect(container.scrollWidth).toBeLessThanOrEqual(window.innerWidth);
});
