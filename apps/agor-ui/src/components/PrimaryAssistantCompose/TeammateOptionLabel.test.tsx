import type { Branch } from '@agor-live/client';
import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { TeammateOptionLabel } from './TeammateOptionLabel';

const option = {
  value: 'branch-ada',
  label: 'Ada',
  emoji: '🎨',
  context: '📋 Research',
  searchText: 'Ada ada 📋 Research',
  branch: { branch_id: 'branch-ada' } as Branch,
};

describe('TeammateOptionLabel', () => {
  it('renders emoji, name and board on one line', () => {
    const { container } = render(<TeammateOptionLabel option={option} />);
    const row = container.firstElementChild as HTMLElement;
    expect(row).toHaveTextContent('🎨Ada📋 Research');
    expect(row.children).toHaveLength(3);
    expect(screen.getByText('🎨')).toHaveAttribute('aria-hidden');
  });

  it('omits the board when the option has no context', () => {
    const { container } = render(
      <TeammateOptionLabel option={{ ...option, context: undefined }} />
    );
    expect(container.firstElementChild?.children).toHaveLength(2);
    expect(screen.queryByText('📋 Research')).not.toBeInTheDocument();
  });
});
