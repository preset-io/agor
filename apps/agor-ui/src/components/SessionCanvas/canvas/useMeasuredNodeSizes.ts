import { type RefObject, useEffect, useRef } from 'react';
import type { MeasuredNodeSize } from './zoneGridLayout';

const MEASURED_NODE_SELECTOR = '.react-flow__node-branchNode, .react-flow__node-cardNode';
/** React Flow containers that, when they mount, carry nodes to start watching. */
const NODE_CONTAINER_CLASSES = ['react-flow', 'react-flow__renderer', 'react-flow__nodes'];

/**
 * Rendered sizes of branch and card nodes, read straight from the DOM: one
 * ResizeObserver reports each node as soon as it appears and whenever it
 * resizes. React Flow's own dimension events arrive late and in batches, so
 * grid layouts placed from them jump once the real sizes land.
 */
export function useMeasuredNodeSizes(
  containerRef: RefObject<HTMLElement | null>,
  onChange: (nodeIds: string[]) => void
) {
  const sizesRef = useRef(new Map<string, MeasuredNodeSize>());
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    const resizeObserver = new ResizeObserver((entries) => {
      const changed: string[] = [];
      for (const entry of entries) {
        const element = entry.target as HTMLElement;
        const nodeId = element.dataset.id;
        if (!nodeId) continue;
        // Layout sizes, unaffected by the canvas zoom transform.
        const size = { width: element.offsetWidth, height: element.offsetHeight };
        const previous = sizesRef.current.get(nodeId);
        if (
          previous &&
          Math.abs(previous.width - size.width) < 1 &&
          Math.abs(previous.height - size.height) < 1
        ) {
          continue;
        }
        sizesRef.current.set(nodeId, size);
        changed.push(nodeId);
      }
      if (changed.length > 0) onChangeRef.current(changed);
    });
    const watchWithin = (root: ParentNode) => {
      for (const element of root.querySelectorAll(MEASURED_NODE_SELECTOR)) {
        resizeObserver.observe(element);
      }
    };
    watchWithin(container);
    // Only node and container mounts matter; card internals changing are ignored cheaply.
    const mutationObserver = new MutationObserver((records) => {
      for (const record of records) {
        for (const removed of record.removedNodes) {
          if (!(removed instanceof HTMLElement) || !removed.matches(MEASURED_NODE_SELECTOR))
            continue;
          resizeObserver.unobserve(removed);
          if (removed.dataset.id) sizesRef.current.delete(removed.dataset.id);
        }
        for (const added of record.addedNodes) {
          if (!(added instanceof HTMLElement)) continue;
          if (added.matches(MEASURED_NODE_SELECTOR)) resizeObserver.observe(added);
          else if (NODE_CONTAINER_CLASSES.some((name) => added.classList.contains(name))) {
            watchWithin(added);
          }
        }
      }
    });
    mutationObserver.observe(container, { childList: true, subtree: true });
    return () => {
      mutationObserver.disconnect();
      resizeObserver.disconnect();
    };
  }, [containerRef]);

  return sizesRef;
}
