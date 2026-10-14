import type React from 'react';

/**
 * Whether a composer keydown should send: plain Enter on a hardware keyboard.
 * Never on touch keyboards, where Return inserts a newline and Send is the
 * button (iOS Return fires a real Enter keydown), and never while an IME is
 * composing, where Enter commits the candidate (Safari reports keyCode 229).
 */
export function isComposerSendKey(e: React.KeyboardEvent, touchInput: boolean): boolean {
  return (
    e.key === 'Enter' &&
    !e.shiftKey &&
    !touchInput &&
    !e.nativeEvent.isComposing &&
    e.nativeEvent.keyCode !== 229
  );
}
