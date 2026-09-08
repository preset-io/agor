/**
 * useTroubleshootError
 *
 * Phase 1 of "Troubleshoot this error with an agent" (issue #2388).
 *
 * Returns `showErrorWithTroubleshoot(content, context)` — a drop-in for
 * `useThemedMessage().showError` that additionally renders a small
 * "Troubleshoot" button on the error toast. Clicking it spins up an agent
 * session on the relevant branch, seeds it with a structured prompt built from
 * the error message + whatever session/board/branch context the caller had,
 * and navigates to the new session.
 *
 * This lives apart from `useThemedMessage` on purpose: the plain toast helpers
 * are used in ~59 files and must stay free of client / router / session
 * dependencies. Callers that DO have the client (SessionPanel, App shell, MCP
 * settings) opt in by using this hook instead.
 *
 * The button degrades gracefully:
 *   - Thin context (only an error string) → agent still opens, prompt is just
 *     the error text; the branch is resolved from the current/first board.
 *   - No branch resolvable at all → a normal error toast explains why, no crash.
 *   - Spawn failure → a normal error toast, the original toast is untouched.
 */
import type { AgorClient } from '@agor-live/client';
import { App } from 'antd';
import type { ReactNode } from 'react';
import { useCallback } from 'react';
import { type AgorState, agorStore } from '../store/agorStore';
import { makeBranchesForBoardSelector, selectFirstBoardId } from '../store/selectors';
import { extractTextContent, MessageContent, type ThemedMessageOptions } from '../utils/message';
import { useAppNavigation } from './useAppNavigation';
import { useSessionActions } from './useSessionActions';

/**
 * Whatever context the error site could scrape together. Every field is
 * optional — the button copes with as little as nothing.
 */
export interface ErrorTroubleshootContext {
  /** Session the error is about (used to resolve the branch + labels). */
  sessionId?: string;
  /** Board the user was on when the error fired. */
  boardId?: string;
  /** Branch the error is about (preferred target for the new session). */
  branchId?: string;
  /** Human-readable label of where the error came from, e.g. "Sending a prompt". */
  source?: string;
  /** Optional stack / diagnostic detail to include in the agent prompt. */
  stack?: string;
}

export interface ResolvedTarget {
  branchId: string;
  boardId?: string;
}

// Unique-enough keys so we can dismiss the originating toast once the agent
// session is on its way. Module-level counter (not Math.random) keeps it
// deterministic and dependency-free.
let troubleshootToastSeq = 0;

/**
 * Resolve the branch to spawn the troubleshooting session on, reading the
 * store at click time (context captured at error time may predate newer data).
 * Prefers explicit branch/session context, then falls back to the given board,
 * the first board, and finally any known branch.
 */
export function resolveTarget(
  context: ErrorTroubleshootContext,
  state: AgorState = agorStore.getState()
): ResolvedTarget | null {
  if (context.branchId) {
    const branch = state.branchById.get(context.branchId);
    if (branch) return { branchId: context.branchId, boardId: branch.board_id ?? undefined };
  }

  if (context.sessionId) {
    const session = state.sessionById.get(context.sessionId);
    if (session?.branch_id) {
      const branch = state.branchById.get(session.branch_id);
      return {
        branchId: session.branch_id,
        boardId: session.branch_board_id ?? branch?.board_id ?? undefined,
      };
    }
  }

  const boardId = context.boardId ?? selectFirstBoardId(state);
  if (boardId) {
    const branches = makeBranchesForBoardSelector(boardId)(state);
    if (branches.length > 0) return { branchId: branches[0].branch_id, boardId };
  }

  const anyBranch = state.branchById.values().next().value;
  if (anyBranch) return { branchId: anyBranch.branch_id, boardId: anyBranch.board_id ?? undefined };

  return null;
}

/**
 * Build the structured prompt handed to the agent. Only includes context
 * blocks that are actually present so a thin error still reads cleanly.
 */
export function buildTroubleshootPrompt(
  errorText: string,
  context: ErrorTroubleshootContext,
  target: ResolvedTarget
): string {
  const lines: string[] = [
    'I hit an error in the Agor UI and need help troubleshooting it. Please diagnose the likely cause, then propose concrete steps or a fix.',
    '',
    '## Error',
    '```',
    errorText.trim() || '(no message)',
    '```',
  ];

  const contextLines: string[] = [];
  if (context.source) contextLines.push(`- Source: ${context.source}`);
  if (context.sessionId) contextLines.push(`- Session: ${context.sessionId}`);
  const boardId = context.boardId ?? target.boardId;
  if (boardId) contextLines.push(`- Board: ${boardId}`);
  contextLines.push(`- Branch: ${context.branchId ?? target.branchId}`);
  if (contextLines.length > 0) {
    lines.push('', '## Context', ...contextLines);
  }

  if (context.stack) {
    lines.push('', '## Stack / details', '```', context.stack.trim(), '```');
  }

  return lines.join('\n');
}

export interface UseTroubleshootErrorResult {
  /**
   * Show an error toast that carries a "Troubleshoot" button. Behaves like
   * `showError` otherwise (same 6s default duration + copy affordance).
   */
  showErrorWithTroubleshoot: (
    content: ReactNode,
    context?: ErrorTroubleshootContext,
    options?: ThemedMessageOptions
  ) => void;
}

export function useTroubleshootError(client: AgorClient | null): UseTroubleshootErrorResult {
  const { message } = App.useApp();
  const { createSession } = useSessionActions(client);
  const { goToSession } = useAppNavigation();

  const showErrorWithTroubleshoot = useCallback(
    (
      content: ReactNode,
      context: ErrorTroubleshootContext = {},
      options?: ThemedMessageOptions
    ) => {
      const errorText = extractTextContent(content);
      const key = options?.key ?? `troubleshoot-error-${troubleshootToastSeq++}`;

      const onTroubleshoot = async () => {
        const target = resolveTarget(context);
        if (!target) {
          message.error('Open a branch first — a troubleshooting session needs somewhere to run.');
          return;
        }

        const prompt = buildTroubleshootPrompt(errorText, context, target);

        try {
          const session = await createSession({
            branch_id: target.branchId,
            agent: 'claude-code',
            title: 'Troubleshoot UI error',
            initialPrompt: prompt,
          });

          // createSession stores the prompt as the session description but does
          // not execute it — send it explicitly so the agent starts working.
          if (client && prompt.trim()) {
            await client.sessions.prompt(session.session_id, prompt);
          }

          message.destroy(key);
          goToSession(session.session_id);
        } catch (err) {
          message.error(
            `Failed to start troubleshooting session: ${
              err instanceof Error ? err.message : String(err)
            }`
          );
        }
      };

      message.error({
        content: (
          <MessageContent textContent={errorText} onTroubleshoot={onTroubleshoot}>
            {content}
          </MessageContent>
        ),
        duration: options?.duration ?? 6,
        key,
        onClose: options?.onClose,
      });
    },
    [message, createSession, goToSession, client]
  );

  return { showErrorWithTroubleshoot };
}
