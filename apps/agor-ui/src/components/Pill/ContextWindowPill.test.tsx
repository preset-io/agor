import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, expect, it } from 'vitest';
import { ContextWindowPill } from './Pill';

afterEach(cleanup);
it.each([22, 85])('shows %i percent once, without a redundant icon', (percentage) => {
  const { container } = render(<ContextWindowPill used={percentage} limit={100} />);
  expect(screen.getByText(`${percentage}%`)).toBeVisible();
  expect(container.querySelector('.anticon-percentage')).toBeNull();
});
