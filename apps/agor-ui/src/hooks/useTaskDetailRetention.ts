import { createContext, type RefObject, useContext, useEffect, useRef } from 'react';

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

/**
 * Keep the turns that hold document focus or an end of a non-collapsed text
 * selection inside `root` cached, released as soon as focus/selection leaves.
 * Evicting such a turn would remount the element a keyboard user is on (for
 * example the trigger of a disclosure they just collapsed) or drop a reader's
 * selection. One document-level listener serves every turn in the conversation.
 */
export function useRetainEngagedTurns(
  root: RefObject<HTMLElement | null>,
  retain: ((taskId: string) => (() => void) | undefined) | undefined
): void {
  const recheck = useRef<(() => void) | null>(null);
  useEffect(() => {
    if (!retain) return;
    const held = new Map<string, () => void>();
    const add = (engaged: Set<string>, node: Node | null | undefined) => {
      const element = node instanceof Element ? node : node?.parentElement;
      const turn = element?.closest<HTMLElement>('[data-task-block]');
      const taskId = turn?.dataset.taskBlock;
      if (taskId && root.current?.contains(turn)) engaged.add(taskId);
    };
    const update = () => {
      const engaged = new Set<string>();
      add(engaged, document.activeElement);
      const selection = document.getSelection();
      if (selection && !selection.isCollapsed) {
        add(engaged, selection.anchorNode);
        add(engaged, selection.focusNode);
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
    recheck.current = update;
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
