import type { ChipFilter } from '../components/GlobalSearch/types';

/** Window events that let a page open header-owned pickers without prop plumbing. */
export const OPEN_BOARD_SWITCHER_EVENT = 'agor:open-board-switcher';
/** `detail` optionally names the GlobalSearch type chip to preselect. */
export const OPEN_GLOBAL_SEARCH_EVENT = 'agor:open-global-search';

/** Each shell picker event and the `detail` it carries. */
export interface ShellPickerEvents {
  [OPEN_BOARD_SWITCHER_EVENT]: undefined;
  [OPEN_GLOBAL_SEARCH_EVENT]: ChipFilter | undefined;
}

type ShellPickerEvent = keyof ShellPickerEvents;

export const requestShellPicker = <E extends ShellPickerEvent>(
  event: E,
  detail?: ShellPickerEvents[E]
) => window.dispatchEvent(new CustomEvent(event, { detail }));

/** Subscribes to a shell picker event; returns the unsubscribe. */
export function onShellPicker<E extends ShellPickerEvent>(
  event: E,
  listener: (detail: ShellPickerEvents[E]) => void
): () => void {
  // A CustomEvent created without detail reports null; listeners see undefined.
  const handler = (e: Event) =>
    listener(((e as CustomEvent).detail ?? undefined) as ShellPickerEvents[E]);
  window.addEventListener(event, handler);
  return () => window.removeEventListener(event, handler);
}
