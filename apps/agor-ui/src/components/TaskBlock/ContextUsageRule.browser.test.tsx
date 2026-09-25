import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, expect, it } from 'vitest';
import { userEvent } from 'vitest/browser';
import { ContextUsageRule } from './ContextUsageRule';

afterEach(cleanup);

it('keeps metadata readable through hover, keyboard focus, touch, and horizontal scrolling', async () => {
  render(
    <div style={{ width: 300 }}>
      <ContextUsageRule
        used={22}
        limit={100}
        snapshot={undefined}
        metadata={<span>{'time · tokens · model · SHA · '.repeat(8)}</span>}
        usageLabel={<button type="button">22% breakdown</button>}
      >
        <p>Assistant answer</p>
      </ContextUsageRule>
    </div>
  );
  const metadata = screen.getByRole('region', { name: 'Turn metadata' });
  const answer = screen.getByText('Assistant answer');
  const breakdown = screen.getByRole('button', { name: '22% breakdown' });
  expect(metadata).toBeVisible();
  await userEvent.hover(answer);
  await userEvent.unhover(answer);
  expect(metadata).toBeVisible();
  breakdown.focus();
  expect(breakdown).toHaveFocus();
  await userEvent.keyboard('{Escape}');
  expect(metadata).toBeVisible();
  expect(metadata.scrollWidth).toBeGreaterThan(metadata.clientWidth);
  expect(metadata.scrollHeight).toBeLessThanOrEqual(metadata.clientHeight + 1);
  metadata.scrollLeft = metadata.scrollWidth;
  expect(metadata.scrollLeft).toBeGreaterThan(0);
  expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(window.innerWidth);
});
