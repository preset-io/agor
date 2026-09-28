/** Window events that let a page open header-owned pickers without prop plumbing. */
export const OPEN_BOARD_SWITCHER_EVENT = 'agor:open-board-switcher';
/** `detail` optionally names the GlobalSearch type chip to preselect. */
export const OPEN_GLOBAL_SEARCH_EVENT = 'agor:open-global-search';

export const requestShellPicker = (event: string, detail?: unknown) =>
  window.dispatchEvent(new CustomEvent(event, { detail }));
