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
  });
});
