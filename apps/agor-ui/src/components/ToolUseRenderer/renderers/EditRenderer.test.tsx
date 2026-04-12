import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { EditRenderer } from './EditRenderer';

describe('EditRenderer', () => {
  it('renders Claude-style old/new input as an inline update diff', () => {
    render(
      <EditRenderer
        toolUseId="tool-edit-1"
        input={{
          file_path: 'src/claude.ts',
          old_string: 'hello',
          new_string: 'world',
        }}
        result={{
          content: 'ok',
        }}
      />
    );

    expect(screen.getByText('Update')).toBeInTheDocument();
    expect(screen.getByText('src/claude.ts')).toBeInTheDocument();
    expect(screen.getByText('hello')).toBeInTheDocument();
    expect(screen.getByText('world')).toBeInTheDocument();
  });
});
