import { render, screen } from '@testing-library/react';
import { theme } from 'antd';
import { describe, expect, it } from 'vitest';
import { buildDiffStatNode } from './toolDescriptions';

function Harness({ additions, deletions }: { additions: number; deletions: number }) {
  const { token } = theme.useToken();
  return <>{buildDiffStatNode({ additions, deletions }, token)}</>;
}

describe('buildDiffStatNode', () => {
  it('reports both sides with the glyphs DiffBlock header uses', () => {
    render(<Harness additions={12} deletions={4} />);

    expect(screen.getByText('+12')).toBeVisible();
    expect(screen.getByText('-4')).toBeVisible();
  });

  it('omits a side that has no lines', () => {
    render(<Harness additions={3} deletions={0} />);

    expect(screen.getByText('+3')).toBeVisible();
    expect(screen.queryByText(/^-/)).not.toBeInTheDocument();
  });
});
