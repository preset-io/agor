/**
 * React hook for real-time task events
 *
 * Tracks tool executions in real-time by listening to WebSocket events
 * emitted when tools start and complete execution.
 */

import type { TaskID } from '@agor/core/types';
import { useEffect, useState } from 'react';
import type { useAgorClient } from './useAgorClient';

export interface ToolExecution {
  toolUseId: string;
  toolName: string;
  status: 'executing' | 'complete';
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

      console.debug(`🔧 Tool start: ${data.tool_name} (${data.tool_use_id.substring(0, 8)})`);

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
            status: 'executing',
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

      console.debug(`✅ Tool complete: ${data.tool_use_id.substring(0, 8)}`);

      setToolsExecuting((prev) => {
        // Mark as complete
        const updated = prev.map((tool) =>
          tool.toolUseId === data.tool_use_id ? { ...tool, status: 'complete' as const } : tool
        );

        return updated;
      });

      // Remove from list after 2 seconds (gives time for visual feedback)
      setTimeout(() => {
        setToolsExecuting((prev) => prev.filter((t) => t.toolUseId !== data.tool_use_id));
      }, 2000);
    };

    // Register event listeners
    // biome-ignore lint/suspicious/noExplicitAny: FeathersJS emit types are not strict
    tasksService.on('tool:start', handleToolStart as any);
    // biome-ignore lint/suspicious/noExplicitAny: FeathersJS emit types are not strict
    tasksService.on('tool:complete', handleToolComplete as any);

    // Cleanup on unmount or client/taskId change
    return () => {
      // biome-ignore lint/suspicious/noExplicitAny: FeathersJS emit types are not strict
      tasksService.removeListener('tool:start', handleToolStart as any);
      // biome-ignore lint/suspicious/noExplicitAny: FeathersJS emit types are not strict
      tasksService.removeListener('tool:complete', handleToolComplete as any);
    };
  }, [client, taskId]);

  return { toolsExecuting };
}
