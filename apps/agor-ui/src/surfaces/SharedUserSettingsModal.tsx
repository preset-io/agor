import type { AgorClient, UpdateUserInput, User } from '@agor-live/client';
import { UserSettingsModal } from '../components/SettingsModal';
import {
  useAuthenticatedAuthorityScope,
  useAuthorityOperationGuard,
} from '../hooks/useAuthorityOperationGuard';
import type { OnboardingReopenMode } from '../utils/onboardingLifecycle';

export interface SharedUserSettingsModalProps {
  open: boolean;
  user: User | null;
  client: AgorClient | null;
  onClose: () => void;
  onUpdateUser: (
    userId: string,
    updates: UpdateUserInput,
    shouldApply?: () => boolean
  ) => Promise<void>;
  onRefreshCurrentUser: (shouldApply: () => boolean) => Promise<unknown>;
  onReopenOnboarding?: (
    mode: OnboardingReopenMode,
    shouldApply?: () => boolean
  ) => void | Promise<void>;
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
  onReopenOnboarding,
  initialTab,
}) => {
  const authority = useAuthenticatedAuthorityScope(
    client,
    user ? `${user.user_id}:${user.role}` : null
  );
  const operationGuard = useAuthorityOperationGuard(authority.operationScope);
  return (
    <UserSettingsModal
      open={open}
      onClose={onClose}
      user={user}
      currentUser={user}
      client={client}
      onUpdate={async (userId, updates, childShouldApply) => {
        const operation = operationGuard.begin();
        const shouldApply = () =>
          operation.isCurrent() && (childShouldApply ? childShouldApply() : true);
        if (!shouldApply()) return;
        await onUpdateUser(userId, updates, shouldApply);
        if (!shouldApply()) return;
        await onRefreshCurrentUser(shouldApply);
        if (!shouldApply()) return;
      }}
      onReopenOnboarding={
        onReopenOnboarding
          ? async (mode, childShouldApply) => {
              const operation = operationGuard.begin();
              const shouldApply = () =>
                operation.isCurrent() && (childShouldApply ? childShouldApply() : true);
              if (!shouldApply()) return;
              await onReopenOnboarding(mode, shouldApply);
              if (!shouldApply()) return;
            }
          : undefined
      }
      initialTab={initialTab}
    />
  );
};
