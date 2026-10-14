import type React from 'react';

/**
 * Whether a composer keydown should send. Never while an IME is composing,
 * where Enter commits the candidate (Safari reports keyCode 229). On touch,
 * plain Return inserts a newline and Send is the button (iOS Return fires a
 * real Enter keydown); Cmd/Ctrl+Enter still sends, since only a hardware
 * keyboard (e.g. on an iPad) produces those modifiers.
 */
export function isComposerSendKey(e: React.KeyboardEvent, touchInput: boolean): boolean {
  if (e.key !== 'Enter' || e.shiftKey) return false;
  if (e.nativeEvent.isComposing || e.nativeEvent.keyCode === 229) return false;
  return !touchInput || e.metaKey || e.ctrlKey;
}
