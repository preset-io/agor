import type { AgorClient, UpdateUserInput, User } from '@agor-live/client';
import { useMemo } from 'react';
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
  onUpdateUser?: (
    userId: string,
    updates: UpdateUserInput,
    shouldApply?: () => boolean
  ) => void | Promise<void>;
  onRefreshCurrentUser?: (shouldApply: () => boolean) => Promise<unknown>;
  onReopenOnboarding?: (
    mode: OnboardingReopenMode,
    shouldApply?: () => boolean
  ) => void | Promise<void>;
  initialTab?: string;
}

/**
 * Shared-surface owner for current-user settings.
 *
 * Workspace and lightweight surfaces share the same persistence/refresh owner.
 * A user menu/settings flow does not require the Workspace route tree to mount.
 * The MCP server map is read by
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
  // Serialize patch + refresh pairs, not just patches: two concurrent fields
  // must not install authentication snapshots in reverse order. A replacement
  // authority owns a fresh queue and never waits for an obsolete request.
  // biome-ignore lint/correctness/useExhaustiveDependencies: a new authority epoch owns a new queue
  const updatesQueue = useMemo(() => ({ pending: null as Promise<void> | null }), [operationGuard]);
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
        const previous = updatesQueue.pending;
        const update = async () => {
          if (previous) await previous.catch(() => {});
          if (!shouldApply()) return;
          await onUpdateUser?.(userId, updates, shouldApply);
          if (!operation.isCurrent()) return;
          // The auth snapshot belongs to the caller, not to the dialog. A
          // route-driven close after persistence must not leave it stale.
          await onRefreshCurrentUser?.(operation.isCurrent);
        };
        const pending = update();
        updatesQueue.pending = pending;
        try {
          await pending;
        } finally {
          if (updatesQueue.pending === pending) updatesQueue.pending = null;
        }
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
