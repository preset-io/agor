import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { EmojiPickerInput } from './EmojiPickerInput';

// Stand in for the lazily-loaded picker so a click can drive onEmojiClick
// without pulling in emoji-picker-react.
vi.mock('./AgorEmojiPickerInner', () => ({
  default: ({ onEmojiClick }: { onEmojiClick: (d: { emoji: string }) => void }) => (
    <button type="button" aria-label="pick smile" onClick={() => onEmojiClick({ emoji: '😀' })}>
      pick
    </button>
  ),
}));

describe('EmojiPickerInput', () => {
  it('renders a single clickable emoji tile as the only trigger', () => {
    render(<EmojiPickerInput value="🤖" onChange={() => {}} />);
    const triggers = screen.getAllByRole('button');
    expect(triggers).toHaveLength(1);
    const tile = screen.getByRole('button', { name: 'Choose emoji' });
    expect(tile).toHaveTextContent('🤖');
    // Read-only: no text field to type into.
    expect(screen.queryByRole('textbox')).toBeNull();
  });

  it('falls back to defaultEmoji when no value is set', () => {
    render(<EmojiPickerInput onChange={() => {}} defaultEmoji="📋" />);
    expect(screen.getByRole('button', { name: 'Choose emoji' })).toHaveTextContent('📋');
  });

  it('opens the picker on click and reports the chosen emoji', async () => {
    const onChange = vi.fn();
    render(<EmojiPickerInput value="🤖" onChange={onChange} />);
    fireEvent.click(screen.getByRole('button', { name: 'Choose emoji' }));
    const pick = await screen.findByLabelText('pick smile');
    fireEvent.click(pick);
    expect(onChange).toHaveBeenCalledWith('😀');
  });

  it('uses a native keyboard-focusable button and closes on Escape', async () => {
    render(<EmojiPickerInput value="🤖" onChange={() => {}} />);
    const tile = screen.getByRole('button', { name: 'Choose emoji' });
    tile.focus();
    expect(tile).toHaveFocus();
    fireEvent.click(tile);
    expect(await screen.findByLabelText('pick smile')).toBeInTheDocument();
    fireEvent.keyDown(document, { key: 'Escape' });
    await waitFor(() => expect(screen.getByLabelText('pick smile')).not.toBeVisible());
    expect(tile).toHaveFocus();
  });

  it('does not open the picker when disabled', async () => {
    render(<EmojiPickerInput value="🤖" onChange={() => {}} disabled />);
    const tile = screen.getByRole('button', { name: 'Choose emoji' });
    expect(tile).toBeDisabled();
    fireEvent.click(tile);
    await waitFor(() => expect(screen.queryByLabelText('pick smile')).toBeNull());
  });
});
