import { createContext, type RefObject, useContext, useEffect, useMemo, useRef } from 'react';

/**
 * Pins the surrounding turn's full detail in the lean transcript cache and
 * returns its release. Provided per turn by TaskBlock; absent elsewhere.
 */
export const TaskDetailRetention = createContext<(() => (() => void) | undefined) | undefined>(
  undefined
);

/** Keep the surrounding turn's tool/reasoning detail cached while `shown`. */
export function useRetainTaskDetailsWhile(shown: boolean): void {
  const retain = useContext(TaskDetailRetention);
  useEffect(() => {
    if (shown) return retain?.();
  }, [shown, retain]);
}

const TURN = '[data-task-block]';

/**
 * Task IDs of the turns a selection range intersects. Usually both boundaries
 * sit in turns: one turn, or a walk across the sibling turns between them.
 * Only a boundary outside every turn (e.g. a range over the whole container)
 * scans the conversation's turns.
 */
function turnsInRange(root: HTMLElement, range: Range, into: Set<string>): void {
  const turnAt = (node: Node) =>
    (node instanceof Element ? node : node.parentElement)?.closest<HTMLElement>(TURN);
  const first = turnAt(range.startContainer);
  const last = turnAt(range.endContainer);
  if (first && last && root.contains(first)) {
    const walked: string[] = [];
    for (let turn: Element | null = first; turn; turn = turn.nextElementSibling) {
      if (turn instanceof HTMLElement && turn.dataset.taskBlock)
        walked.push(turn.dataset.taskBlock);
      if (turn !== last) continue;
      for (const taskId of walked) into.add(taskId);
      return;
    }
  }
  // A boundary outside any turn, or turns that are not siblings.
  for (const turn of root.querySelectorAll<HTMLElement>(TURN)) {
    if (turn.dataset.taskBlock && range.intersectsNode(turn)) into.add(turn.dataset.taskBlock);
  }
}

/**
 * Keep the turns that hold document focus or intersect a non-collapsed text
 * selection inside `root` cached, released as soon as focus/selection leaves.
 * Evicting such a turn would remount the element a keyboard user is on (for
 * example the trigger of a disclosure they just collapsed) or drop content
 * from a reader's selection. One document-level listener serves every turn.
 */
export function useRetainEngagedTurns(
  root: RefObject<HTMLElement | null>,
  retain: ((taskId: string) => (() => void) | undefined) | undefined
): void {
  const recheck = useRef<(() => void) | null>(null);
  useEffect(() => {
    if (!retain) return;
    const held = new Map<string, () => void>();
    // selectionchange fires on every caret or drag step; reuse unchanged ranges.
    let selectionKey: unknown[] = [];
    let selected = new Set<string>();
    const selectedTurns = (container: HTMLElement) => {
      const selection = document.getSelection();
      if (!selection || selection.isCollapsed) return new Set<string>();
      const ranges = Array.from({ length: selection.rangeCount }, (_, i) =>
        selection.getRangeAt(i)
      );
      const key = ranges.flatMap((r) => [
        r.startContainer,
        r.startOffset,
        r.endContainer,
        r.endOffset,
      ]);
      if (key.length === selectionKey.length && key.every((part, i) => part === selectionKey[i])) {
        return selected;
      }
      selectionKey = key;
      selected = new Set();
      for (const range of ranges) turnsInRange(container, range, selected);
      return selected;
    };
    const update = () => {
      const container = root.current;
      const engaged = new Set<string>();
      if (container) {
        const focused = document.activeElement?.closest<HTMLElement>(TURN);
        if (focused?.dataset.taskBlock && container.contains(focused)) {
          engaged.add(focused.dataset.taskBlock);
        }
        for (const taskId of selectedTurns(container)) engaged.add(taskId);
      }
      // Pin the new turn before releasing the old one.
      for (const taskId of engaged) {
        if (held.has(taskId)) continue;
        const release = retain(taskId);
        if (release) held.set(taskId, release);
      }
      for (const [taskId, release] of held) {
        if (engaged.has(taskId)) continue;
        held.delete(taskId);
        release();
      }
    };
    // focusout fires before focus lands; read the settled activeElement.
    const afterFocusOut = () => queueMicrotask(update);
    document.addEventListener('focusin', update);
    document.addEventListener('focusout', afterFocusOut);
    document.addEventListener('selectionchange', update);
    // After a commit the DOM under unchanged range boundaries may differ.
    recheck.current = () => {
      selectionKey = [];
      update();
    };
    update();
    return () => {
      recheck.current = null;
      document.removeEventListener('focusin', update);
      document.removeEventListener('focusout', afterFocusOut);
      document.removeEventListener('selectionchange', update);
      for (const release of held.values()) release();
      held.clear();
    };
  }, [root, retain]);
  // A commit can remove the focused node without a focusout event.
  useEffect(() => {
    recheck.current?.();
  });
}

/** Open overlays a turn can own: modal viewers (portaled or not) and link confirmation. */
const OVERLAY = '[aria-modal="true"], [data-streamdown="link-safety-modal"]';

/**
 * Keep a turn cached while an overlay it opened stays open, e.g. Streamdown's
 * fullscreen table/Mermaid viewers, which portal to `document.body` outside
 * the turn's DOM. Evicting the turn would remount its message and close the
 * viewer mid-use. Ownership follows React's tree: a click inside the turn that
 * opens an overlay, or a focus/pointer event bubbling out of a portaled one,
 * attributes it to this turn. The pin is released when the overlay leaves the
 * document. Spread `handlers` and attach `ref` to the turn's root element.
 */
export function useRetainTurnOverlays(retain: () => (() => void) | undefined) {
  const ref = useRef<HTMLDivElement | null>(null);
  const held = useRef(new Map<Element, () => void>());
  const observer = useRef<MutationObserver | null>(null);
  const mounted = useRef(true);
  const handlers = useMemo(() => {
    const releaseClosed = () => {
      for (const [overlay, release] of held.current) {
        if (overlay.isConnected) continue;
        held.current.delete(overlay);
        release();
      }
      if (held.current.size === 0) {
        observer.current?.disconnect();
        observer.current = null;
      }
    };
    const adopt = (overlay: Element) => {
      if (!mounted.current || held.current.has(overlay)) return;
      const release = retain();
      if (!release) return;
      held.current.set(overlay, release);
      observer.current ??= new MutationObserver(releaseClosed);
      observer.current.observe(document.body, { childList: true, subtree: true });
    };
    const fromPortal = (event: { target: EventTarget }) => {
      const target = event.target;
      if (!(target instanceof Element) || ref.current?.contains(target)) return;
      const overlay = target.closest(OVERLAY);
      if (overlay) adopt(overlay);
    };
    return {
      onClickCapture: (event: { target: EventTarget }) => {
        fromPortal(event);
        // An overlay opened by this click mounts once React flushes it.
        const before = new Set(document.querySelectorAll(OVERLAY));
        setTimeout(() => {
          for (const overlay of document.querySelectorAll(OVERLAY)) {
            if (!before.has(overlay)) adopt(overlay);
          }
        });
      },
      onFocusCapture: fromPortal,
      onPointerDownCapture: fromPortal,
    };
  }, [retain]);
  useEffect(() => {
    const overlays = held.current;
    mounted.current = true;
    return () => {
      mounted.current = false;
      observer.current?.disconnect();
      observer.current = null;
      for (const release of overlays.values()) release();
      overlays.clear();
    };
  }, []);
  return { ref, handlers };
}
