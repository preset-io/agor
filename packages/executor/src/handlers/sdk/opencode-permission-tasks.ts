import type { TaskID } from '@agor/core/types';
import type { TasksService } from '../../sdk-handlers/base/service-clients.js';

/** Scope permission lifecycle patches to the admitted managed holder. */
export function managedOpenCodePermissionTasksService(
  tasksService: TasksService,
  taskId: TaskID,
  holderId?: string
): TasksService {
  if (!holderId) return tasksService;
  return {
    get: (id) => tasksService.get(id),
    patch: (id, data) => {
      if (id !== taskId) throw new Error('Permission patch is not scoped to this task');
      return tasksService.patch(id, { ...data, native_state_holder_instance_id: holderId });
    },
    emit: (event, data) => tasksService.emit(event, data),
  };
}
