import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, expect, it } from 'vitest';
import { userEvent } from 'vitest/browser';
import { FadeText } from './FadeText';

const LONG = 'Refactor session permissions approval flow for teams and gateways';

afterEach(cleanup);

function mount(title: string, dir?: 'rtl') {
  render(
    <div dir={dir} data-fade-row style={{ display: 'flex', width: 200, position: 'relative' }}>
      <button
        type="button"
        style={{ display: 'flex', flex: 1, minWidth: 0, padding: 0, border: 0 }}
      >
        <FadeText data-testid="title">{title}</FadeText>
      </button>
      <span data-fade-row-actions style={{ position: 'absolute', insetInlineEnd: 0, width: 60 }} />
    </div>
  );
  return screen.getByTestId('title');
}

it('masks the end of a title only when the layout clips it', async () => {
  const clipped = mount(LONG);
  await expect.poll(() => getComputedStyle(clipped).maskImage).toContain('to right');
  expect(getComputedStyle(clipped).textOverflow).toBe('clip');
  cleanup();

  const fitting = mount('Short title');
  expect(fitting).not.toHaveAttribute('data-overflowing');
  expect(getComputedStyle(fitting).maskImage).toBe('none');
});

it('fades the start edge of right-to-left text', async () => {
  const title = mount(LONG, 'rtl');
  await expect.poll(() => getComputedStyle(title).maskImage).toContain('to left');
});

it('ends the fade where the row actions begin while the row is hovered', async () => {
  const title = mount(LONG);
  await expect.poll(() => getComputedStyle(title).maskImage).toContain('calc(100% - 24px)');

  await userEvent.hover(title);

  await expect.poll(() => getComputedStyle(title).maskImage).toContain('calc(100% - 84px)');
  expect(getComputedStyle(title).maskImage).toContain('calc(100% - 60px)');

  await userEvent.unhover(title);
  await expect.poll(() => getComputedStyle(title).maskImage).toContain('calc(100% - 24px)');
});
