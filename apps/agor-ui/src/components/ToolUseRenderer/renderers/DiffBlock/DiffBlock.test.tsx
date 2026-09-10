import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

vi.mock('@/utils/message', () => ({
  useThemedMessage: () => ({ showSuccess: vi.fn(), showWarning: vi.fn() }),
}));

import { DiffBlock } from './DiffBlock';

describe('DiffBlock computation limit', () => {
  it('shows a useful fallback when a raw diff exceeds the synchronous budget', () => {
    const before = Array.from({ length: 1001 }, (_, index) => `before ${index}`).join('\n');
    const after = Array.from({ length: 1001 }, (_, index) => `after ${index}`).join('\n');

    render(
      <DiffBlock
        filePath="large.txt"
        operationType="edit"
        oldContent={before}
        newContent={after}
        rawContentKind="full-file"
        forceExpanded
      />
    );

    expect(screen.getByText('Diff preview limited')).toBeInTheDocument();
    expect(screen.getByText(/too complex to compute safely/i)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Copy diff' })).not.toBeInTheDocument();
  });
});
