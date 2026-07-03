import { useCallback, useLayoutEffect, useRef } from 'react';

/**
 * Freeze a callback's identity for the component's lifetime while always
 * invoking the latest implementation. Handlers that close over frequently
 * changing state (store maps, live-patched entities) get a fresh identity on
 * every render; passing them into memoized children — or into React Flow node
 * `data` compared by a custom `areEqual` — defeats those memo boundaries on
 * every live patch. The wrapper's identity is stable; a ref keeps it
 * delegating to the current impl, so behavior is unchanged. Preserves
 * `undefined` so optional handlers stay absent (no spurious enabled UI).
 */
export function useStableCallback<TFn extends (...args: never[]) => unknown>(callback: TFn): TFn;
export function useStableCallback<TFn extends (...args: never[]) => unknown>(
  callback: TFn | undefined
): TFn | undefined;
export function useStableCallback<TFn extends (...args: never[]) => unknown>(
  callback: TFn | undefined
): TFn | undefined {
  const callbackRef = useRef(callback);
  useLayoutEffect(() => {
    callbackRef.current = callback;
  });
  const stable = useCallback(((...args: never[]) => callbackRef.current?.(...args)) as TFn, []);
  return callback ? stable : undefined;
}
