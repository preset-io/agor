// `ansi-to-react` ships as CJS with `__esModule: true` and `exports.default =
// Component`. Under some bundler interop paths (most notably Rollup's commonjs
// plugin in Vite production builds) the namespace gets double-wrapped, so
// `import Ansi from 'ansi-to-react'` yields `{ default: Component }` instead
// of `Component`. Rendering `<Ansi>` in that state passes an object as the
// element type and triggers React error #130 ("got: object"). Unwrap once
// here so all callers get a real component reference.
import AnsiDefault from 'ansi-to-react';

type AnsiComponent = typeof AnsiDefault;

const nested = (AnsiDefault as unknown as { default?: AnsiComponent }).default;
export const Ansi: AnsiComponent =
  typeof AnsiDefault === 'function' ? AnsiDefault : (nested ?? AnsiDefault);
