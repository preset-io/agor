import type { StreamingMessageState } from '@agor-live/client';
import { useMemo, useRef } from 'react';

/**
 * Check if two Maps are equal (same keys and same content)
 * Used to maintain stable Map references for React memoization.
 */
function mapsAreEqual<K, V>(map1: Map<K, V>, map2: Map<K, V>): boolean {
  if (map1.size !== map2.size) return false;

  for (const [key, value1] of map1.entries()) {
    const value2 = map2.get(key);
    // For StreamingMessage objects, compare by reference (they're immutable updates)
    if (value1 !== value2) return false;
  }

  return true;
}

/**
 * Group reactive-session streaming messages by task while preserving stable
 * per-task Map references when the grouped contents did not actually change.
 *
 * TaskBlock is heavily memoized; returning fresh Map instances for every
 * streaming chunk would invalidate every task block in a conversation/card.
 */
export function useStreamingMessagesByTask(
  streamingMessages: Map<string, StreamingMessageState>
): Map<string, Map<string, StreamingMessageState>> {
  const prevTaskMapsRef = useRef<Map<string, Map<string, StreamingMessageState>>>(new Map());

  return useMemo(() => {
    const result = new Map<string, Map<string, StreamingMessageState>>();
    const prevMaps = prevTaskMapsRef.current;

    // Group messages by task_id
    const tempByTask = new Map<string, Map<string, StreamingMessageState>>();
    for (const [msgId, streamingMsg] of streamingMessages.entries()) {
      if (streamingMsg.task_id) {
        if (!tempByTask.has(streamingMsg.task_id)) {
          tempByTask.set(streamingMsg.task_id, new Map());
        }
        tempByTask.get(streamingMsg.task_id)!.set(msgId, streamingMsg);
      }
    }

    // Reuse previous Map references when content is identical.
    for (const [taskId, newTaskMap] of tempByTask.entries()) {
      const prevTaskMap = prevMaps.get(taskId);
      result.set(
        taskId,
        prevTaskMap && mapsAreEqual(prevTaskMap, newTaskMap) ? prevTaskMap : newTaskMap
      );
    }

    prevTaskMapsRef.current = result;
    return result;
  }, [streamingMessages]);
}
