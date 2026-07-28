import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { ToolBlock } from './ToolBlock';
import { deriveToolStatus, renderToolStatusIcon } from './toolStatus';

describe('tool status presentation', () => {
  it.each([
    ['stalled', 'Agent progress stalled'],
    ['stale', 'Agent moved on — result not captured'],
  ] as const)('exposes %s status by accessible name and keyboard focus', async (status, name) => {
    render(
      <ToolBlock icon={renderToolStatusIcon(status)} name="Bash">
        <div>Tool details</div>
      </ToolBlock>
    );

    const accessibleStatus = screen.getByRole('button', { name });
    expect(within(accessibleStatus).queryByRole('img')).not.toBeInTheDocument();
    expect(accessibleStatus.querySelector('[aria-hidden="true"]')).toBeInTheDocument();
    expect(
      screen.queryByRole('button', {
        name:
          status === 'stalled' ? 'Agent moved on — result not captured' : 'Agent progress stalled',
      })
    ).not.toBeInTheDocument();

    act(() => accessibleStatus.focus());
    expect(accessibleStatus).toHaveFocus();
    expect(await screen.findByRole('tooltip')).toHaveTextContent(name);
    act(() => accessibleStatus.blur());
  });

  it.each([
    [
      'click',
      () => fireEvent.click(screen.getByRole('button', { name: 'Agent progress stalled' })),
    ],
    [
      'Enter',
      () => {
        const control = screen.getByRole('button', { name: 'Agent progress stalled' });
        fireEvent.keyDown(control, { key: 'Enter' });
        fireEvent.keyUp(control, { key: 'Enter' });
        fireEvent.click(control, { detail: 0 });
      },
    ],
    [
      'Space',
      () => {
        const control = screen.getByRole('button', { name: 'Agent progress stalled' });
        fireEvent.keyDown(control, { key: ' ' });
        fireEvent.keyUp(control, { key: ' ' });
        fireEvent.click(control, { detail: 0 });
      },
    ],
  ] as const)('keeps ToolBlock collapsed when status is activated by %s', (_name, activate) => {
    render(
      <ToolBlock icon={renderToolStatusIcon('stalled')} name="Bash">
        <div>Tool details</div>
      </ToolBlock>
    );

    expect(screen.queryByText('Tool details')).not.toBeInTheDocument();
    activate();
    expect(screen.queryByText('Tool details')).not.toBeInTheDocument();
  });

  it('derives stalled status for unfinished tools while agent progress is stalled', () => {
    expect(
      deriveToolStatus({
        hasResult: false,
        isPotentiallyRunning: true,
        taskProgressState: 'stalled',
      })
    ).toBe('stalled');
  });
});
