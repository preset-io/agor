import { fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mockInnerState = vi.hoisted(() => ({
  error: new Error('Unset emoji picker test error'),
}));

vi.mock('./AgorEmojiPickerInner', () => ({
  default: function MockAgorEmojiPickerInner(): never {
    throw mockInnerState.error;
  },
}));

import { AgorEmojiPicker, EmojiPickerErrorFallback } from './EmojiPickerInput';

const dynamicImportError = new TypeError(
  'Failed to fetch dynamically imported module: http://localhost/AgorEmojiPickerInner.tsx'
);

beforeEach(() => {
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('EmojiPickerErrorFallback', () => {
  it('offers a page reload after a dynamic-import load failure', () => {
    const onReload = vi.fn();

    render(
      <EmojiPickerErrorFallback
        error={
          new TypeError(
            'Failed to fetch dynamically imported module: http://localhost/AgorEmojiPickerInner.tsx'
          )
        }
        onReload={onReload}
      />
    );

    expect(screen.getByText("Couldn't load the emoji picker.")).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Reload page' }));
    expect(onReload).toHaveBeenCalledOnce();
  });

  it('uses a neutral contained fallback for programming errors', () => {
    render(<EmojiPickerErrorFallback error={new Error('Module initialization failed')} />);

    expect(screen.getByText('The emoji picker is unavailable.')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Reload page' })).not.toBeInTheDocument();
  });
});

describe('AgorEmojiPicker', () => {
  it('contains a lazy-module load failure without replacing its surrounding flow', async () => {
    mockInnerState.error = dynamicImportError;

    render(
      <div>
        <span>Onboarding remains available</span>
        <AgorEmojiPicker onEmojiClick={() => {}} />
      </div>
    );

    expect(await screen.findByText("Couldn't load the emoji picker.")).toBeInTheDocument();
    expect(screen.getByText('Onboarding remains available')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Reload page' })).toBeInTheDocument();
  });
});
