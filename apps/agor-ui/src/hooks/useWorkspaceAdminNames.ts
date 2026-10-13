import { useMemo } from 'react';
import { workspaceAdminNames } from '../components/MCPServer/memberPolicy';
import { useAgorStore } from '../store/agorStore';

/** The workspace's administrators by name, from the user directory the app already holds. */
export function useWorkspaceAdminNames(): string[] {
  const userById = useAgorStore((s) => s.userById);
  return useMemo(() => workspaceAdminNames(userById.values()), [userById]);
}
