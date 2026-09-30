import type { AgorClient, Branch, User } from '@agor-live/client';
import { App as AntApp } from 'antd';
import { useCallback, useRef, useState } from 'react';
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
  /** The caller's synchronous gate (disabled, content, config validity), checked before a send is held or run, including one resumed by `pick`. */
  canSend?: () => boolean;
  /** The caller's async checks (form fields), run once a target is known; also runs for a send resumed by `pick`. */
  validate?: () => Promise<boolean>;
  /** Re-resolves the primary assistant when it changes. */
  refreshKey?: unknown;
  onSent?: () => void;
  onOpenSession?: (sessionId: string) => void;
}

/**
 * Send a prompt to the caller's primary assistant (or an explicit teammate), in
 * the background or opening the new session. One send runs at a time. Without a
 * primary, a send is held until `pick` supplies one. An identity change abandons
 * any in-flight send and drops a held one. `primaryBranch` is null while the
 * primary belongs to a previous caller, so a held send always shows the picker.
 */
export function usePrimaryAssistantSend(options: PrimaryAssistantSendOptions) {
  const latest = useRef(options);
  latest.current = options;
  const { client, currentUser, authenticationGeneration = 0, refreshKey } = options;
  const { message } = AntApp.useApp();
  const navigation = useAppNavigation();
  const primary = usePrimaryTeammate(
    client,
    currentUser?.user_id,
    authenticationGeneration,
    refreshKey
  );
  const runtime = useRef({ primary, message, navigation });
  runtime.current = { primary, message, navigation };

  const [pendingSend, setPendingSendState] = useState<ComposeSendMode | null>(null);
  const pendingSendRef = useRef<ComposeSendMode | null>(null);
  const [submitting, setSubmitting] = useState<ComposeSendMode | null>(null);
  // Refuses a second send synchronously; `submitting` only shows the first one as pending.
  const inFlightRef = useRef(false);

  const setPendingSend = useCallback((mode: ComposeSendMode | null) => {
    pendingSendRef.current = mode;
    setPendingSendState(mode);
  }, []);

  // An abandoned send never reaches its `finally`, so the identity change releases its state.
  const guard = useIdentityGuardedAsync([currentUser?.user_id, authenticationGeneration], () => {
    inFlightRef.current = false;
    setSubmitting(null);
    setPendingSend(null);
  });

  const send = useCallback(
    async (mode: ComposeSendMode, explicitBranch?: Branch) => {
      if (inFlightRef.current || latest.current.canSend?.() === false) return;
      const { primary: resolved, message: toast, navigation: nav } = runtime.current;
      if (!explicitBranch && (resolved.resolving || resolved.failed)) return;
      // A primary resolved for a previous caller is never sent to.
      const branch = explicitBranch ?? (resolved.ownedByCaller ? resolved.branch : null);
      if (!branch) {
        setPendingSend(mode);
        return;
      }
      inFlightRef.current = true;
      try {
        const opts = latest.current;
        if (opts.validate && !(await guard.run(opts.validate))) return;
        const create = opts.onCreateSession;
        if (!create) return;
        const generation = opts.authenticationGeneration ?? 0;
        setSubmitting(mode);
        const outcome = await guard.run(() =>
          create(opts.buildConfig(branch), branch.board_id ?? opts.currentBoardId ?? '')
        );
        if (!outcome || opts.isAuthenticationGenerationCurrent?.(generation) === false) return;
        setPendingSend(null);
        opts.onSent?.();
        if (mode === 'background') {
          toast.success(`Sent to ${teammateLabel(branch)} in the background`);
        } else {
          (opts.onOpenSession ?? nav.goToSession)(outcome.sessionId);
        }
      } finally {
        inFlightRef.current = false;
        setSubmitting(null);
      }
    },
    [guard, setPendingSend]
  );

  const pick = useCallback(
    (branch: Branch) => {
      runtime.current.primary.setBranch(branch);
      const mode = pendingSendRef.current;
      if (!mode) return;
      setPendingSend(null);
      void send(mode, branch);
    },
    [send, setPendingSend]
  );

  const clearPendingSend = useCallback(() => setPendingSend(null), [setPendingSend]);

  return {
    primaryBranch: primary.ownedByCaller ? primary.branch : null,
    setPrimaryBranch: primary.setBranch,
    resolving: primary.resolving,
    resolveFailed: primary.failed,
    retryResolve: primary.refresh,
    pendingSend,
    clearPendingSend,
    submitting,
    send,
    pick,
  };
}
