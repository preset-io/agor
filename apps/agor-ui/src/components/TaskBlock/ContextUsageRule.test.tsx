import { generateId } from '@agor/core/ids/browser';
import type { ContextUsageSnapshot } from '@agor/core/types';
import { type Message, MessageRole, type Task, TaskStatus } from '@agor-live/client';
import { fireEvent, render, screen, within } from '@testing-library/react';
import { theme } from 'antd';
import { describe, expect, it, vi } from 'vitest';
import { ContextUsageRule } from './ContextUsageRule';
import { TaskBlock } from './TaskBlock';

/** The muted band colors the rule is expected to pick, from the live theme. */
function tokens() {
  let read: { success: string; warning: string; error: string } | undefined;
  function Probe() {
    const { token } = theme.useToken();
    read = {
      success: token.colorSuccessBorder,
      warning: token.colorWarningBorder,
      error: token.colorErrorBorder,
    };
    return null;
  }
  render(<Probe />);
  if (!read) throw new Error('theme not read');
  return read;
}

const view = (props: Partial<React.ComponentProps<typeof ContextUsageRule>> = {}) =>
  render(
    <ContextUsageRule used={undefined} limit={undefined} snapshot={undefined} {...props}>
      <p>Assistant answer</p>
    </ContextUsageRule>
  );

const rule = () => document.querySelector<HTMLElement>('[data-testid="context-usage-rule"]');

/** Token colors are hex; the style they land in reads back as rgb(). */
const asRenderedColor = (color: string) => {
  const probe = document.createElement('div');
  probe.style.color = color;
  return probe.style.color;
};

/** The band color and fill the line draws, without pinning the CSS string. */
const band = (el: HTMLElement) => {
  const match = el.style.background.match(/^linear-gradient\(to right, (.+?) (\d+)%/);
  if (!match) throw new Error(`not a band gradient: ${el.style.background}`);
  return { color: match[1], fill: Number(match[2]) };
};

describe('ContextUsageRule', () => {
  it('renders nothing extra for a turn with no usage data', () => {
    view();

    expect(screen.getByText('Assistant answer')).toBeVisible();
    expect(rule()).toBeNull();
  });

  it('renders nothing extra when a used count has no limit to measure against', () => {
    view({ used: 40_000, limit: 0 });

    expect(rule()).toBeNull();
  });

  it.each([
    ['low', 12_000, 100_000, 12, 'success'],
    ['mid', 60_000, 100_000, 60, 'warning'],
    ['high', 91_000, 100_000, 91, 'error'],
  ] as const)(
    'uses the %s band color and shows the percentage',
    (_label, used, limit, pct, bandName) => {
      const expected = asRenderedColor(tokens()[bandName]);
      view({ used, limit });

      const line = rule()!;
      expect(line).toBeVisible();
      expect(screen.getByText(`${pct}%`)).toBeVisible();
      // The gradient stops at the usage percentage, so the line reads as a
      // fill as well as a band color.
      expect(band(line.firstElementChild as HTMLElement)).toEqual({ color: expected, fill: pct });
    }
  );

  it('dims the line at rest and draws it at full strength while the answer is hovered', () => {
    const border = asRenderedColor(tokens().error);
    view({ used: 91_000, limit: 100_000 });
    const line = rule()!.firstElementChild as HTMLElement;
    const opacity = () => Number(line.style.opacity || 1);

    expect(opacity()).toBeGreaterThan(0);
    expect(opacity()).toBeLessThan(1);
    expect(band(line).color).toBe(border);

    fireEvent.mouseEnter(screen.getByText('Assistant answer').parentElement!);
    expect(opacity()).toBe(1);
    expect(band(line).color).toBe(border);
  });

  it("prefers the executor's authoritative snapshot percentage over used/limit", () => {
    const snapshot = {
      totalTokens: 10_000,
      maxTokens: 100_000,
      percentage: 85,
    } as ContextUsageSnapshot;
    view({ used: 10_000, limit: 100_000, snapshot });

    expect(screen.getByText('85%')).toBeVisible();
    expect(band(rule()!.firstElementChild as HTMLElement)).toEqual({
      color: asRenderedColor(tokens().error),
      fill: 85,
    });
  });

  it('names the absolute token counts behind the percentage on hover', async () => {
    view({ used: 30_000, limit: 200_000 });

    fireEvent.mouseOver(rule()!);
    expect(
      await screen.findByText('Context window · 30,000 / 200,000 tokens (15%)')
    ).toBeInTheDocument();
  });

  it('tips the percentage alone when no absolute counts were reported', async () => {
    view({
      used: undefined,
      limit: undefined,
      snapshot: { totalTokens: 0, maxTokens: 0, percentage: 15 } as ContextUsageSnapshot,
    });

    fireEvent.mouseOver(rule()!);
    expect(await screen.findByText('Context window · 15% used')).toBeInTheDocument();
  });
});

describe('ContextUsageRule in a task turn', () => {
  const baseTask = {
    task_id: generateId(),
    session_id: generateId(),
    created_by: '',
    full_prompt: 'Do the thing',
    status: TaskStatus.COMPLETED,
    created_at: '2026-09-01T00:00:00.000Z',
    model: 'synthetic-model',
    git_state: { ref_at_start: 'main', sha_at_start: 'synthetic' },
  } satisfies Task;

  const answer = {
    message_id: generateId(),
    task_id: baseTask.task_id,
    session_id: baseTask.session_id,
    index: 0,
    role: MessageRole.ASSISTANT,
    type: 'assistant',
    timestamp: baseTask.created_at,
    content_preview: '',
    content: 'Here is the answer',
  } as unknown as Message;

  const message = (index: number, role: MessageRole, content: string): Message =>
    ({
      message_id: `message-${index}`,
      task_id: baseTask.task_id,
      session_id: baseTask.session_id,
      index,
      role,
      type: role === MessageRole.USER ? 'user' : 'assistant',
      timestamp: baseTask.created_at,
      content_preview: '',
      content,
    }) as unknown as Message;

  const withUsage = (base: Task): Task =>
    ({
      ...base,
      computed_context_window: 42_000,
      normalized_sdk_response: {
        contextWindowLimit: 100_000,
        tokenUsage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
      },
    }) as unknown as Task;

  /** A turn still running, so usage has not landed yet. */
  const runningTurn = (props: Partial<React.ComponentProps<typeof TaskBlock>>) => (
    <TaskBlock
      task={{ ...baseTask, status: TaskStatus.RUNNING }}
      taskMessages={[answer]}
      taskMessagesLoaded
      onLoadTaskMessages={vi.fn()}
      {...props}
    />
  );

  const turn = (task: Task) =>
    render(
      <TaskBlock
        task={task}
        taskMessages={[answer]}
        taskMessagesLoaded
        onLoadTaskMessages={vi.fn()}
      />
    );

  it('reads the turn usage the context pill reads', () => {
    turn({
      ...baseTask,
      computed_context_window: 12_000,
      normalized_sdk_response: {
        contextWindowLimit: 100_000,
        tokenUsage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
      },
    } as unknown as Task);

    expect(rule()).toBeVisible();
    // Scoped: the turn's metadata pills carry the same percentage.
    expect(within(rule()!).getByText('12%')).toBeVisible();
  });

  it('does not remount the answer when context usage arrives at turn end', () => {
    const streamed = [
      message(0, MessageRole.USER, 'Do the thing'),
      message(1, MessageRole.ASSISTANT, 'Partial answer'),
    ];
    const { container, rerender } = render(runningTurn({ taskMessages: streamed }));
    const answerBefore = container.querySelector('[data-conversation-block]');
    expect(container.querySelector('[data-testid="context-usage-rule"]')).toBeNull();

    // Usage data only lands once the turn completes. The answer's DOM has to
    // survive that, or the whole turn visibly flashes as it finishes.
    rerender(runningTurn({ task: withUsage(baseTask), taskMessages: streamed }));

    expect(container.querySelector('[data-testid="context-usage-rule"]')).not.toBeNull();
    expect(container.querySelector('[data-conversation-block]')).toBe(answerBefore);
  });

  it('adds nothing to a turn the executor reported no usage for', () => {
    turn(baseTask);

    expect(screen.getByText('Here is the answer')).toBeVisible();
    expect(rule()).toBeNull();
  });
});
