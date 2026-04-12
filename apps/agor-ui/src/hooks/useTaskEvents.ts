/**
 * React hook for real-time task events
 *
 * Tracks tool executions in real-time by listening to WebSocket events
 * emitted when tools start and complete execution.
 */

import type { TaskID } from '@agor-live/client';
import { useEffect, useState } from 'react';
import type { FeathersEventHandler } from './index';
import type { useAgorClient } from './useAgorClient';

export interface ToolExecution {
  toolUseId: string;
  toolName: string;
  status: 'executing';
}

interface ToolStartEvent {
  task_id: TaskID;
  session_id: string;
  tool_use_id: string;
  tool_name: string;
}

interface ToolCompleteEvent {
  task_id: TaskID;
  session_id: string;
  tool_use_id: string;
}

/**
 * Hook to track real-time tool executions for a task
 *
 * @param client - Agor client instance from useAgorClient
 * @param taskId - Task ID to filter tool events (optional)
 * @returns Array of currently executing/recently completed tools
 */
export function useTaskEvents(
  client: ReturnType<typeof useAgorClient>['client'],
  taskId?: TaskID
): { toolsExecuting: ToolExecution[] } {
  const [toolsExecuting, setToolsExecuting] = useState<ToolExecution[]>([]);

  useEffect(() => {
    if (!client || !taskId) {
      return;
    }

    const tasksService = client.service('tasks');

    // Handler for tool:start
    const handleToolStart = (data: ToolStartEvent) => {
      // Only track tools for this task
      if (data.task_id !== taskId) {
        return;
      }

      setToolsExecuting((prev) => {
        // Avoid duplicates
        if (prev.some((t) => t.toolUseId === data.tool_use_id)) {
          return prev;
        }

        return [
          ...prev,
          {
            toolUseId: data.tool_use_id,
            toolName: data.tool_name,
            status: 'executing' as const,
          },
        ];
      });
    };

    // Handler for tool:complete
    const handleToolComplete = (data: ToolCompleteEvent) => {
      // Only track tools for this task
      if (data.task_id !== taskId) {
        return;
      }

      // Remove immediately on completion. The tool row itself already shows completion state.
      setToolsExecuting((prev) => prev.filter((t) => t.toolUseId !== data.tool_use_id));
    };

    // Register event listeners
    // FeathersJS .on() expects (event: string, handler: (data: T) => void) but these
    // handlers receive custom tool event payloads, not Task objects.
    tasksService.on('tool:start', handleToolStart as FeathersEventHandler);
    tasksService.on('tool:complete', handleToolComplete as FeathersEventHandler);

    // Cleanup on unmount or client/taskId change
    return () => {
      tasksService.removeListener('tool:start', handleToolStart as FeathersEventHandler);
      tasksService.removeListener('tool:complete', handleToolComplete as FeathersEventHandler);
    };
  }, [client, taskId]);

  return { toolsExecuting };
}
