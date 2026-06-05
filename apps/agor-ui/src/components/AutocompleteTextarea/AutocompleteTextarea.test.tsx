import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { useState } from 'react';
import { describe, expect, it } from 'vitest';
import { AutocompleteTextarea } from './AutocompleteTextarea';

const renderSlashAutocomplete = () => {
  const Harness = () => {
    const [value, setValue] = useState('');

    return (
      <AutocompleteTextarea
        value={value}
        onChange={setValue}
        placeholder="Prompt"
        client={null}
        sessionId={null}
        userById={new Map()}
        slashCommands={['alpha', 'beta']}
      />
    );
  };

  render(<Harness />);
  return screen.getByPlaceholderText('Prompt') as HTMLTextAreaElement;
};

describe('AutocompleteTextarea', () => {
  it('navigates autocomplete options with arrow keys and selects the highlighted item', async () => {
    const textarea = renderSlashAutocomplete();

    fireEvent.change(textarea, { target: { value: '/', selectionStart: 1 } });

    await screen.findByText('alpha');
    expect(screen.getByText('beta')).toBeInTheDocument();

    fireEvent.keyDown(textarea, { key: 'ArrowDown', code: 'ArrowDown', keyCode: 40, which: 40 });
    fireEvent.keyDown(textarea, { key: 'Enter' });

    await waitFor(() => {
      expect(textarea).toHaveValue('/beta ');
    });
  });

  it('navigates autocomplete options upward with arrow keys', async () => {
    const textarea = renderSlashAutocomplete();

    fireEvent.change(textarea, { target: { value: '/', selectionStart: 1 } });

    await screen.findByText('alpha');
    expect(screen.getByText('beta')).toBeInTheDocument();

    fireEvent.keyDown(textarea, { key: 'ArrowDown', code: 'ArrowDown', keyCode: 40, which: 40 });
    fireEvent.keyDown(textarea, { key: 'ArrowUp', code: 'ArrowUp', keyCode: 38, which: 38 });
    fireEvent.keyDown(textarea, { key: 'Enter' });

    await waitFor(() => {
      expect(textarea).toHaveValue('/alpha ');
    });
  });
});
