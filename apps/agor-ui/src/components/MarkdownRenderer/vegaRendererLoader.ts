import type { ComponentType } from 'react';
import type { CustomRendererProps } from 'streamdown';

export const VEGA_RENDERER_LOAD_TIMEOUT_MS = 15_000;

export interface VegaRendererModule {
  VegaLiteRenderer: ComponentType<CustomRendererProps>;
}

/**
 * Bound the lazy component load separately from chart execution. A cold dev
 * server gets more time than a chart, but a broken chunk cannot leave an
 * indefinite skeleton in the conversation.
 */
export function loadVegaRenderer(
  importer: () => Promise<VegaRendererModule> = () => import('./VegaLiteRenderer')
): Promise<VegaRendererModule> {
  return promiseWithTimeout(
    importer(),
    VEGA_RENDERER_LOAD_TIMEOUT_MS,
    'Vega-Lite renderer could not be loaded in time.'
  );
}

function promiseWithTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  message: string
): Promise<T> {
  return new Promise((resolve, reject) => {
    const timeout = window.setTimeout(() => reject(new Error(message)), timeoutMs);
    promise.then(
      (value) => {
        window.clearTimeout(timeout);
        resolve(value);
      },
      (error) => {
        window.clearTimeout(timeout);
        reject(error);
      }
    );
  });
}
