import type { ControlsConfig } from 'streamdown';

/** Mirrors Streamdown's code-control defaults for custom fenced renderers. */
export function isCodeCopyEnabled(controls: ControlsConfig): boolean {
  if (typeof controls === 'boolean') return controls;
  if (controls.code === false) return false;
  if (controls.code === true || controls.code === undefined) return true;
  return controls.code.copy !== false;
}
