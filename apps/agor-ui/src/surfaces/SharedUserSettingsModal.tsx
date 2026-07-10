import type { AgorClient, UpdateUserInput, User } from '@agor-live/client';
import { UserSettingsModal } from '../components/SettingsModal';

export interface SharedUserSettingsModalProps {
  open: boolean;
  user: User | null;
  client: AgorClient | null;
  onClose: () => void;
  onUpdateUser: (userId: string, updates: UpdateUserInput) => Promise<void>;
  onRefreshCurrentUser: () => Promise<unknown>;
  onRestartOnboarding?: () => void | Promise<void>;
  initialTab?: string;
}

/**
 * Shared-surface owner for current-user settings.
 *
 * Workspace still renders its full settings stack inside `AgorApp`; lightweight
 * surfaces use this wrapper so a user menu/settings flow does not require the
 * Workspace route tree to mount first. The MCP server map is read by
 * `UserSettingsModal` straight from the store, so a fresh Knowledge deep link
 * that has not loaded Workspace data yet simply sees an empty map.
 */
export const SharedUserSettingsModal: React.FC<SharedUserSettingsModalProps> = ({
  open,
  user,
  client,
  onClose,
  onUpdateUser,
  onRefreshCurrentUser,
  onRestartOnboarding,
  initialTab,
}) => (
  <UserSettingsModal
    open={open}
    onClose={onClose}
    user={user}
    currentUser={user}
    client={client}
    onUpdate={async (userId, updates) => {
      await onUpdateUser(userId, updates);
      await onRefreshCurrentUser();
    }}
    onRestartOnboarding={onRestartOnboarding}
    initialTab={initialTab}
  />
);
