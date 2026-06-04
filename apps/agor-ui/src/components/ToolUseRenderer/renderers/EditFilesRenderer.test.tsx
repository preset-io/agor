import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { EditFilesRenderer } from './EditFilesRenderer';

describe('EditFilesRenderer', () => {
  it('renders structured diff output for Codex edit_files when diff enrichment is present', () => {
    render(
      <EditFilesRenderer
        toolUseId="tool-edit-files-1"
        input={{
          changes: [{ path: 'src/example.ts', kind: 'update' }],
        }}
        result={{
          content: '[completed]',
          diff: {
            structuredPatch: [
              {
                oldStart: 1,
                oldLines: 1,
                newStart: 1,
                newLines: 1,
                lines: ['-const value = "old";', '+const value = "new";'],
              },
            ],
            files: [
              {
                path: 'src/example.ts',
                kind: 'update',
                structuredPatch: [
                  {
                    oldStart: 1,
                    oldLines: 1,
                    newStart: 1,
                    newLines: 1,
                    lines: ['-const value = "old";', '+const value = "new";'],
                  },
                ],
              },
            ],
          },
        }}
      />
    );

    expect(screen.getByText('Update')).toBeInTheDocument();
    expect(screen.getByText('src/example.ts')).toBeInTheDocument();
    expect(
      screen.getByText((_, element) => element?.textContent === 'const value = "old";')
    ).toBeInTheDocument();
    expect(
      screen.getByText((_, element) => element?.textContent === 'const value = "new";')
    ).toBeInTheDocument();
    expect(screen.getByText('+1')).toBeInTheDocument();
    expect(screen.getByText('-1')).toBeInTheDocument();

    const labelText = screen.getByText('Update');
    const label = labelText.closest('.ant-typography') ?? labelText;
    expect(label).toHaveStyle({
      whiteSpace: 'nowrap',
      overflow: 'hidden',
      textOverflow: 'ellipsis',
    });
  });

  it('keeps edit_files operation labels on one line with ellipsis styles', () => {
    render(
      <div style={{ width: 80 }}>
        <EditFilesRenderer
          toolUseId="tool-edit-files-fallback"
          input={{
            changes: [
              {
                path: 'apps/agor-ui/src/components/very/long/path/example.tsx',
                kind: 'update',
              },
            ],
          }}
          result={{ content: '[completed]' }}
        />
      </div>
    );

    const labelText = screen.getByText('Update');
    const label = labelText.closest('.ant-typography') ?? labelText;
    expect(label).toHaveStyle({
      whiteSpace: 'nowrap',
      overflow: 'hidden',
      textOverflow: 'ellipsis',
    });
  });
});
