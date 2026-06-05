import type { AgorClient, MCPServer, UpdateUserInput, User } from '@agor-live/client';
import { UserSettingsModal } from '../components/SettingsModal';

const EMPTY_MCP_SERVER_MAP: Map<string, MCPServer> = new Map();

export interface SharedUserSettingsModalProps {
  open: boolean;
  user: User | null;
  client: AgorClient | null;
  mcpServerById?: Map<string, MCPServer>;
  onClose: () => void;
  onUpdateUser: (userId: string, updates: UpdateUserInput) => Promise<void>;
  onRefreshCurrentUser: () => Promise<unknown>;
}

/**
 * Shared-surface owner for current-user settings.
 *
 * Workspace still renders its full settings stack inside `AgorApp`; lightweight
 * surfaces use this wrapper so a user menu/settings flow does not require the
 * Workspace route tree to mount first. The MCP server map is optional because
 * a fresh Knowledge deep link intentionally has not loaded Workspace data yet.
 */
export const SharedUserSettingsModal: React.FC<SharedUserSettingsModalProps> = ({
  open,
  user,
  client,
  mcpServerById = EMPTY_MCP_SERVER_MAP,
  onClose,
  onUpdateUser,
  onRefreshCurrentUser,
}) => (
  <UserSettingsModal
    open={open}
    onClose={onClose}
    user={user}
    currentUser={user}
    mcpServerById={mcpServerById}
    client={client}
    onUpdate={async (userId, updates) => {
      await onUpdateUser(userId, updates);
      await onRefreshCurrentUser();
    }}
  />
);
