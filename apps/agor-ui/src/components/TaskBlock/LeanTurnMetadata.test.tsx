import { generateId } from '@agor/core/ids/browser';
import { type Message, MessageRole, type Task, TaskStatus } from '@agor-live/client';
import { fireEvent, render, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { ContextWindowPill, ModelPill } from '../Pill';
import { LeanTurnMetadata } from './LeanTurnMetadata';
import { TaskBlock } from './TaskBlock';

// Inline styles rather than getComputedStyle: jsdom's css parser throws on
// antd's CSS-variable `border` shorthand.
const task = {
  task_id: generateId(),
  session_id: generateId(),
  created_by: '',
  full_prompt: 'Do the thing',
  status: TaskStatus.COMPLETED,
  created_at: '2026-09-01T00:00:00.000Z',
  model: 'synthetic-model',
  git_state: { ref_at_start: 'main', sha_at_start: 'synthetic' },
  computed_context_window: 13_000,
  normalized_sdk_response: {
    contextWindowLimit: 100_000,
    tokenUsage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
  },
} as unknown as Task;

const answer = {
  message_id: generateId(),
  task_id: task.task_id,
  session_id: task.session_id,
  index: 0,
  role: MessageRole.ASSISTANT,
  type: 'assistant',
  timestamp: task.created_at,
  content_preview: '',
  content: 'Here is the answer',
} as unknown as Message;

const turn = () =>
  render(
    <TaskBlock
      task={task}
      taskMessages={[answer]}
      taskMessagesLoaded
      onLoadTaskMessages={vi.fn()}
    />
  ).container;

const metadataRegion = (container: HTMLElement) =>
  container.querySelector<HTMLElement>('[aria-label="Turn metadata"]')!;

describe('turn metadata chrome', () => {
  it('renders the turn values as borderless, dimmed text rather than pills', () => {
    const container = turn();

    const tags = metadataRegion(container).querySelectorAll<HTMLElement>('.ant-tag');
    expect(tags.length).toBeGreaterThan(0);
    for (const tag of tags) {
      expect(tag.style.background).toBe('transparent');
      expect(tag.style.borderStyle).toBe('none');
      expect(tag.style.paddingInline).toBe('0');
      // Dimmed rather than the pill's saturated preset color.
      expect(tag.style.color).not.toBe('');
    }
  });

  it('leaves the same pills fully chromed outside the overlay', () => {
    const { container } = render(
      <div>
        <ContextWindowPill used={13_000} limit={100_000} />
        <ModelPill model="synthetic-model" />
      </div>
    );

    const tags = container.querySelectorAll<HTMLElement>('.ant-tag');
    expect(tags).toHaveLength(2);
    for (const tag of tags) {
      // Outside the overlay the preset classes still own the chrome.
      expect(tag.style.background).toBe('');
      expect(tag.style.borderStyle).toBe('');
      expect(tag.style.paddingInline).toBe('');
    }
  });

  it('keeps the values present and revealable once hovered', () => {
    const container = render(
      <LeanTurnMetadata metadata={<ModelPill model="synthetic-model" />}>
        <p>Prompt</p>
      </LeanTurnMetadata>
    ).container;
    const region = metadataRegion(container);

    expect(region).toHaveAttribute('aria-hidden', 'true');
    fireEvent.mouseEnter(container.querySelector('[aria-label="User prompt and turn metadata"]')!);

    expect(region).toHaveAttribute('aria-hidden', 'false');
    expect(within(region).getByText('synthetic-model')).toBeInTheDocument();
  });
});
