/**
 * Shared React Flow class contract.
 *
 * React Flow starts a node drag only when the event target is inside
 * `dragHandle`, and refuses drags from elements with its `nodrag` class.
 * Keep the selector and class names in one place so card renderers, canvas
 * node configuration, and tests don't drift.
 */
export const REACT_FLOW_DRAG_HANDLE_CLASS = 'drag-handle';
export const REACT_FLOW_DRAG_HANDLE_SELECTOR = `.${REACT_FLOW_DRAG_HANDLE_CLASS}`;
export const REACT_FLOW_NO_DRAG_CLASS = 'nodrag';
// React Flow's default zoom/pan-on-scroll intercepts every wheel event over
// the canvas, including inside a node. Elements with this class are excluded,
// so the browser's native scroll wheel works over a node's own scrollable
// content instead of zooming/panning the board.
export const REACT_FLOW_NO_WHEEL_CLASS = 'nowheel';
