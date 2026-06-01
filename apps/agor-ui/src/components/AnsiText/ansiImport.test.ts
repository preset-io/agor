/**
 * Direct regression test for the `Ansi` import shim.
 *
 * Pins the failure mode that caused React error #130 in production builds:
 * `ansi-to-react` ships as CJS with `__esModule: true` and `exports.default
 * = Component`, and under some bundler interop paths the default import gets
 * double-wrapped — `import Ansi from 'ansi-to-react'` resolves to
 * `{ default: Component }` instead of the function itself. The shim
 * (`./ansiImport.ts`) must unwrap that and hand back a callable, otherwise
 * every `<Ansi>` in the app is a #130 timebomb.
 *
 * `vi.mock` is hoisted, so `ansi-to-react` is replaced at module-init time —
 * exactly mirroring what the bundler interop did.
 */

import { describe, expect, it, vi } from 'vitest';

const FakeAnsi = (props: { children?: unknown }) => null as unknown;

vi.mock('ansi-to-react', () => ({
  // Reproduce the broken interop shape: the consumer's default import
  // resolves to this object, *not* the function inside it.
  default: { default: FakeAnsi },
}));

describe('Ansi import shim', () => {
  it('unwraps the double-wrapped default export to a callable component', async () => {
    const { Ansi } = await import('./ansiImport');
    expect(typeof Ansi).toBe('function');
    expect(Ansi).toBe(FakeAnsi);
  });
});
