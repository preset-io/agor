import { generateId } from '@agor/core/ids/browser';
import type { ContextUsageSnapshot } from '@agor/core/types';
import { type Message, MessageRole, type Task, TaskStatus } from '@agor-live/client';
import { render, screen, within } from '@testing-library/react';
import { theme } from 'antd';
import { describe, expect, it, vi } from 'vitest';
import { ContextUsageRule } from './ContextUsageRule';
import { TaskBlock } from './TaskBlock';

/** The muted band colors the rule is expected to pick, from the live theme. */
function tokens() {
  let read:
    | { success: string; warning: string; error: string; text: Record<string, string> }
    | undefined;
  function Probe() {
    const { token } = theme.useToken();
    read = {
      success: token.colorSuccessBorder,
      warning: token.colorWarningBorder,
      error: token.colorErrorBorder,
      text: { rest: token.colorTextTertiary, revealed: token.colorTextSecondary },
    };
    return null;
  }
  render(<Probe />);
  if (!read) throw new Error('theme not read');
  return read;
}

const view = (props: Partial<React.ComponentProps<typeof ContextUsageRule>> = {}) =>
  render(
    <ContextUsageRule
      used={undefined}
      limit={undefined}
      snapshot={undefined}
      usageLabel={undefined}
      {...props}
    >
      <p>Assistant answer</p>
    </ContextUsageRule>
  );

const metadataRegion = () => screen.queryByLabelText('Turn metadata');

// AntD renders the tooltip in a portal on hover, so the rule is located
// structurally rather than by a `title` attribute.
const rule = () => screen.queryByTestId('context-usage-rule');

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
  it('draws no line for a turn with no usage data', () => {
    view();

    expect(screen.getByText('Assistant answer')).toBeVisible();
    expect(rule()).toBeNull();
  });

  it('draws no line when a used count has no limit to measure against', () => {
    view({ used: 40_000, limit: 0 });

    expect(rule()).toBeNull();
  });

  it('still shows the usage label when there is no fill to draw', () => {
    // A turn can report usage without a limit. The pill says so ('?'), and
    // losing it because there is no gradient would lose that.
    view({ used: 40_000, limit: 0, usageLabel: <span>? via pill</span> });

    expect(rule()).toBeNull();
    expect(screen.getByText('? via pill')).toBeInTheDocument();
  });

  it.each([
    ['low', 12_000, 100_000, 12, 'success'],
    ['mid', 60_000, 100_000, 60, 'warning'],
    ['high', 91_000, 100_000, 91, 'error'],
  ] as const)(
    'fills the line to the usage percentage in the %s band',
    (_label, used, limit, pct, bandName) => {
      view({ used, limit });

      expect(rule()).toBeVisible();
      expect(band(rule()!)).toEqual({ color: asRenderedColor(tokens()[bandName]), fill: pct });
    }
  );

  it("prefers the executor's authoritative snapshot percentage over used/limit", () => {
    const snapshot = {
      totalTokens: 10_000,
      maxTokens: 100_000,
      percentage: 85,
    } as ContextUsageSnapshot;
    view({ used: 10_000, limit: 100_000, snapshot });

    expect(band(rule()!)).toEqual({ color: asRenderedColor(tokens().error), fill: 85 });
  });

  it('still renders the footer values on a turn with no usage data', () => {
    view({ metadata: <span>synthetic-model</span> });

    expect(rule()).toBeNull();
    expect(metadataRegion()).toBeVisible();
    expect(screen.getByText('synthetic-model')).toBeVisible();
  });

  it('keeps the latest gauge visible beside metadata', () => {
    view({ used: 12_000, limit: 100_000, usageLabel: <span>12% via pill</span> });
    const label = screen.getByTestId('turn-usage-label');
    expect(label.style.color).toBe(asRenderedColor(tokens().text.revealed));
    expect(rule()).toBeVisible();
  });

  it("shows the caller's label as the only percentage in the row", () => {
    view({ used: 12_000, limit: 100_000, usageLabel: <span>12% via pill</span> });

    expect(screen.getByTestId('turn-usage-label')).toHaveTextContent('12% via pill');
    expect(screen.queryByText('12%')).toBeNull();
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

  const turn = (task: Task, currentUserId?: string) =>
    render(
      <TaskBlock
        task={task}
        currentUserId={currentUserId}
        isLatestTask
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
    expect(within(screen.getByTestId('turn-usage-label')).getByText('12%')).toBeVisible();
  });

  it.each([
    { creator: 'me', viewer: 'me', tokens: true, valueCount: 2, creatorVisible: false },
    { creator: 'me', viewer: 'me', tokens: false, valueCount: 1, creatorVisible: false },
    { creator: 'teammate', viewer: 'me', tokens: true, valueCount: 3, creatorVisible: true },
    { creator: 'teammate', viewer: 'me', tokens: false, valueCount: 2, creatorVisible: true },
    { creator: '', viewer: 'me', tokens: true, valueCount: 2, creatorVisible: false },
    { creator: '', viewer: 'me', tokens: false, valueCount: 1, creatorVisible: false },
  ])(
    'separates only visible metadata for creator=$creator, tokens=$tokens',
    ({ creator, viewer, tokens, valueCount, creatorVisible }) => {
      turn(
        {
          ...baseTask,
          created_by: creator,
          model: undefined,
          git_state: { ref_at_start: 'main', sha_at_start: 'unknown' },
          normalized_sdk_response: tokens
            ? {
                contextWindowLimit: 100_000,
                tokenUsage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
              }
            : undefined,
        } as Task,
        viewer
      );

      const region = screen.getByRole('region', { name: 'Turn metadata' });
      const values = region.firstElementChild!;
      const children = Array.from(values.children);
      const dots = children.filter((child) => child.textContent === '·');
      expect(region).toBeVisible();
      expect(children).toHaveLength(valueCount * 2 - 1);
      expect(dots).toHaveLength(valueCount - 1);
      expect(dots.every((dot) => dot.getAttribute('aria-hidden') === 'true')).toBe(true);
      expect(
        children.every((child, index) => (index % 2 === 1) === (child.textContent === '·'))
      ).toBe(true);
      expect(within(region).queryByText('Unknown User') !== null).toBe(creatorVisible);
    }
  );

  it('keeps the actual percentage Tag readable at rest', () => {
    turn({
      ...baseTask,
      computed_context_window: 12_000,
      normalized_sdk_response: {
        contextWindowLimit: 100_000,
        tokenUsage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
      },
    } as unknown as Task);
    const tag = screen.getByText('12%');
    expect(getComputedStyle(tag).color).toBe(asRenderedColor(tokens().text.revealed));
  });

  it('adds nothing to a turn the executor reported no usage for', () => {
    turn(baseTask);

    expect(screen.getByText('Here is the answer')).toBeVisible();
    expect(rule()).toBeNull();
  });

  it('moves the sole gauge to a new turn without remounting the old answer or losing its metadata', () => {
    const withUsage = (task: Task) =>
      ({
        ...task,
        computed_context_window: 12_000,
        normalized_sdk_response: {
          contextWindowLimit: 100_000,
          tokenUsage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
        },
      }) as unknown as Task;
    const first = withUsage(baseTask);
    const second = withUsage({ ...baseTask, task_id: generateId(), full_prompt: 'Next turn' });
    const secondAnswer = {
      ...answer,
      task_id: second.task_id,
      message_id: generateId(),
      content: 'Second answer',
    };
    const history = (showSecond: boolean) => (
      <>
        <TaskBlock
          key={first.task_id}
          task={first}
          isLatestTask={!showSecond}
          taskMessages={[answer]}
          taskMessagesLoaded
          onLoadTaskMessages={vi.fn()}
        />
        {showSecond && (
          <TaskBlock
            key={second.task_id}
            task={second}
            isLatestTask
            taskMessages={[secondAnswer]}
            taskMessagesLoaded
            onLoadTaskMessages={vi.fn()}
          />
        )}
      </>
    );
    const { rerender, container } = render(history(false));
    const oldTurn = container.querySelector<HTMLElement>(`[data-task-block="${first.task_id}"]`)!;
    const oldAnswer = screen.getByText('Here is the answer');
    expect(within(oldTurn).getByTestId('context-usage-rule')).toBeInTheDocument();

    rerender(history(true));

    expect(container.querySelectorAll('[data-testid="context-usage-rule"]')).toHaveLength(1);
    expect(container.querySelectorAll('[data-testid="turn-usage-label"]')).toHaveLength(1);
    expect(within(oldTurn).queryByTestId('context-usage-rule')).toBeNull();
    expect(within(oldTurn).queryByTestId('turn-usage-label')).toBeNull();
    expect(oldTurn.querySelector('[aria-label="Turn metadata"]')).not.toBeNull();
    expect(oldTurn.querySelector('[aria-label="Turn metadata"]')).toBeVisible();
    expect(oldTurn).toContainElement(oldAnswer);
    expect(screen.getByText('Here is the answer')).toBe(oldAnswer);
    expect(
      within(
        container.querySelector<HTMLElement>(`[data-task-block="${second.task_id}"]`)!
      ).getByTestId('turn-usage-label')
    ).toHaveTextContent('12%');
  });
});
