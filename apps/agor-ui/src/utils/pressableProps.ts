import type { KeyboardEvent } from 'react';

/** Props that make a non-button element activate like a button (click, Enter, Space). */
export function pressableProps(onActivate: () => void) {
  return {
    role: 'button' as const,
    tabIndex: 0,
    onClick: onActivate,
    onKeyDown: (event: KeyboardEvent) => {
      // A key pressed on a nested control (e.g. a row action) belongs to that control.
      if (event.target !== event.currentTarget) return;
      if (event.key === 'Enter' || event.key === ' ') {
        event.preventDefault();
        onActivate();
      }
    },
  };
}
