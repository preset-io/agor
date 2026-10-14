import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, expect, it } from 'vitest';
import { userEvent } from 'vitest/browser';
import '../../index.css';
import { FadeText } from './FadeText';

const LONG = 'Refactor session permissions approval flow for teams and gateways';

afterEach(cleanup);

function mount(title: string, dir?: 'rtl') {
  render(
    <div dir={dir} data-fade-row style={{ display: 'flex', width: 200 }}>
      <button type="button" style={{ display: 'flex', flex: 1, minWidth: 0 }}>
        <FadeText data-testid="title">{title}</FadeText>
      </button>
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

it('fades earlier on row hover to clear row actions', async () => {
  const title = mount(LONG);
  await expect.poll(() => getComputedStyle(title).maskImage).toContain('24px');

  await userEvent.hover(title);

  await expect.poll(() => getComputedStyle(title).maskImage).toContain('84px');
  expect(getComputedStyle(title).maskImage).toContain('56px');
});
