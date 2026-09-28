import type { AgorClient, Branch, User } from '@agor-live/client';
import { App as AntApp } from 'antd';
import { useRef, useState } from 'react';
import type { NewSessionConfig, SessionCreationResult } from '../../domain/sessionCreation';
import { useAppNavigation } from '../../hooks/useAppNavigation';
import { useIdentityGuardedAsync } from '../../hooks/useIdentityGuardedAsync';
import { usePrimaryTeammate } from '../../hooks/usePrimaryTeammate';
import { teammateLabel } from '../../utils/teammateLabels';

export type ComposeSendMode = 'open' | 'background';

export interface PrimaryAssistantSendOptions {
  client: AgorClient | null;
  currentUser?: User | null;
  authenticationGeneration?: number;
  isAuthenticationGenerationCurrent?: (generation: number) => boolean;
  /** Fallback board when the branch has none: the board in view, or '' off-board. */
  currentBoardId?: string;
  onCreateSession?: (
    config: NewSessionConfig,
    boardId: string
  ) => Promise<SessionCreationResult | null>;
  buildConfig: (branch: Branch) => NewSessionConfig;
  validate?: () => Promise<boolean>;
  /** Re-resolves the primary assistant when it changes. */
  refreshKey?: unknown;
  onSent?: () => void;
  onOpenSession?: (sessionId: string) => void;
}

/**
 * Send a prompt to the caller's primary assistant, in the background or opening
 * the new session. Without a primary, a send is held until `pick` supplies one.
 */
export function usePrimaryAssistantSend(options: PrimaryAssistantSendOptions) {
  const latest = useRef(options);
  latest.current = options;
  const { client, currentUser, authenticationGeneration = 0, refreshKey } = options;
  const { message } = AntApp.useApp();
  const navigation = useAppNavigation();
  const guard = useIdentityGuardedAsync([currentUser?.user_id, authenticationGeneration]);
  const primary = usePrimaryTeammate(
    client,
    currentUser?.user_id,
    authenticationGeneration,
    refreshKey
  );
  const [pendingSend, setPendingSend] = useState<ComposeSendMode | null>(null);
  const [submitting, setSubmitting] = useState<ComposeSendMode | null>(null);

  const send = async (mode: ComposeSendMode, branch = primary.branch) => {
    const opts = latest.current;
    const create = opts.onCreateSession;
    if (!create) return;
    if (!branch) {
      setPendingSend(mode);
      return;
    }
    if (opts.validate && !(await opts.validate())) return;
    const generation = opts.authenticationGeneration ?? 0;
    setSubmitting(mode);
    try {
      const outcome = await guard.run(() =>
        create(opts.buildConfig(branch), branch.board_id ?? opts.currentBoardId ?? '')
      );
      if (!outcome || opts.isAuthenticationGenerationCurrent?.(generation) === false) return;
      opts.onSent?.();
      if (mode === 'background') {
        message.success(`Sent to ${teammateLabel(branch)} in the background`);
      } else {
        (opts.onOpenSession ?? navigation.goToSession)(outcome.sessionId);
      }
    } finally {
      setSubmitting(null);
    }
  };

  const pick = (branch: Branch) => {
    primary.setBranch(branch);
    if (!pendingSend) return;
    setPendingSend(null);
    void send(pendingSend, branch);
  };

  return {
    primaryBranch: primary.branch,
    setPrimaryBranch: primary.setBranch,
    resolving: primary.resolving,
    resolveFailed: primary.failed,
    retryResolve: primary.refresh,
    pendingSend,
    clearPendingSend: () => setPendingSend(null),
    submitting,
    send,
    pick,
  };
}
