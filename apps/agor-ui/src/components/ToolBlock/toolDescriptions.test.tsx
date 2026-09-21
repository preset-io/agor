import type { DiffEnrichment } from '@agor-live/client';
import { render, screen } from '@testing-library/react';
import { theme } from 'antd';
import { describe, expect, it } from 'vitest';
import { buildDiffStatDescriptionNode } from './toolDescriptions';

/** Renders the node the way a collapsed ToolBlock row would. */
function Harness({ tool, diff }: { tool: string; diff?: DiffEnrichment }) {
  const { token } = theme.useToken();
  return <>{buildDiffStatDescriptionNode(tool, 'src/Card.tsx', diff, token) ?? null}</>;
}

const patch = (lines: string[]) => [{ oldStart: 1, oldLines: 1, newStart: 1, newLines: 2, lines }];

describe('buildDiffStatDescriptionNode', () => {
  it('reports the change size for a single-file Claude edit', () => {
    render(<Harness tool="Edit" diff={{ structuredPatch: patch(['-a', '+b', '+c', ' d']) }} />);

    expect(screen.getByText('+2')).toBeVisible();
    expect(screen.getByText('−1')).toBeVisible();
    expect(screen.getByText('src/Card.tsx')).toBeVisible();
  });

  it('totals the per-file patches a Codex edit_files result carries', () => {
    render(
      <Harness
        tool="edit_files"
        diff={{
          structuredPatch: [],
          files: [
            { path: 'a.ts', kind: 'update', structuredPatch: patch(['+one', '-two']) },
            { path: 'b.ts', kind: 'add', structuredPatch: patch(['+three']) },
          ],
        }}
      />
    );

    expect(screen.getByText('+2')).toBeVisible();
    expect(screen.getByText('−1')).toBeVisible();
  });

  it('omits a side of the stat that has no lines', () => {
    render(<Harness tool="Write" diff={{ structuredPatch: patch(['+only']) }} />);

    expect(screen.getByText('+1')).toBeVisible();
    expect(screen.queryByText(/−/)).not.toBeInTheDocument();
  });

  it.each([
    ['a tool that does not edit files', 'Bash', { structuredPatch: patch(['+a']) }],
    ['a result with no diff', 'Edit', undefined],
    ['a diff with no changed lines', 'Edit', { structuredPatch: patch([' context']) }],
  ])('renders nothing for %s', (_label, tool, diff) => {
    const { container } = render(<Harness tool={tool} diff={diff as DiffEnrichment | undefined} />);

    expect(container).toBeEmptyDOMElement();
  });
});
