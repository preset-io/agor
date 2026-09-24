import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, it } from 'vitest';
import { userEvent } from 'vitest/browser';
import { ContextUsageRule } from './ContextUsageRule';

afterEach(cleanup);

function view() {
  render(
    <ContextUsageRule
      used={22}
      limit={100}
      snapshot={undefined}
      metadata={<span>time · tokens · SHA</span>}
      usageLabel={<span>22%</span>}
    >
      <p>Ordinary assistant answer text</p>
      <button type="button">Answer action</button>
    </ContextUsageRule>
  );
  return {
    turn: screen.getByLabelText('Turn and its metadata'),
    answer: screen.getByText('Ordinary assistant answer text'),
    metadata: screen.getByLabelText('Turn metadata'),
  };
}

it('reveals on hover, then hides after the pointer leaves', async () => {
  const { answer, metadata } = view();
  expect(metadata).toHaveStyle({ visibility: 'hidden' });
  await userEvent.hover(answer);
  expect(metadata).toHaveStyle({ visibility: 'visible' });
  await userEvent.unhover(answer);
  await waitFor(() => expect(metadata).toHaveStyle({ visibility: 'hidden' }));
});

it('does not latch after a mouse click on ordinary answer text', async () => {
  const { answer, metadata } = view();
  await userEvent.click(answer);
  expect(metadata).toHaveStyle({ visibility: 'visible' });
  await userEvent.unhover(answer);
  await waitFor(() => expect(metadata).toHaveStyle({ visibility: 'hidden' }));
  await userEvent.tab();
  expect(screen.getByRole('button', { name: 'Answer action' })).toHaveFocus();
  expect(metadata).toHaveStyle({ visibility: 'visible' });
});

it('keeps the footer visible for keyboard focus after hover ends', async () => {
  const { turn, metadata } = view();
  await userEvent.tab();
  expect(turn).toHaveFocus();
  expect(metadata).toHaveStyle({ visibility: 'visible' });
  await userEvent.unhover(turn);
  expect(metadata).toHaveStyle({ visibility: 'visible' });
  await userEvent.tab();
  expect(screen.getByRole('button', { name: 'Answer action' })).toHaveFocus();
  expect(metadata).toHaveStyle({ visibility: 'visible' });
  await userEvent.keyboard('{Escape}');
  await waitFor(() => expect(metadata).toHaveStyle({ visibility: 'hidden' }));
});

it('pins on a touch tap until another tap dismisses it', async () => {
  const { answer, metadata } = view();
  fireEvent.pointerDown(answer, { pointerType: 'touch', clientX: 20, clientY: 20 });
  fireEvent.pointerUp(answer, { pointerType: 'touch', clientX: 20, clientY: 20 });
  expect(metadata).toHaveStyle({ visibility: 'visible' });
  await userEvent.unhover(answer);
  expect(metadata).toHaveStyle({ visibility: 'visible' });
  fireEvent.pointerDown(answer, { pointerType: 'touch', clientX: 20, clientY: 20 });
  fireEvent.pointerUp(answer, { pointerType: 'touch', clientX: 20, clientY: 20 });
  await waitFor(() => expect(metadata).toHaveStyle({ visibility: 'hidden' }));
});
