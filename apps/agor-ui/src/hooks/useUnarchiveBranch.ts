import type { AgorClient } from '@agor-live/client';
import { useCallback, useEffect, useRef } from 'react';
import { isTransientConnectionError } from '../utils/authErrors';
import { useThemedMessage } from '../utils/message';

const ACKNOWLEDGEMENT_WAIT_MS = 30_000;
const UNKNOWN_OUTCOME =
  'Unarchive outcome unknown: no acknowledgement received. Refresh the page to check the branch and filesystem status before trying again. The request has not been replayed.';

/** Bound this UI wait, not the mutation. A late acknowledgement is still useful. */
export function useUnarchiveBranch(client: AgorClient | null | undefined) {
  const { showLoading, showSuccess, showError, showWarning, destroy } = useThemedMessage();
  const operations = useRef(new Map<string, { promise: Promise<void>; dispose: () => void }>());
  const toastKeys = useRef(new Set<string>());

  useEffect(() => {
    if (!client) return;
    const pending = operations.current;
    const keys = toastKeys.current;
    return () => {
      for (const operation of pending.values()) operation.dispose();
      pending.clear();
      for (const key of keys) destroy(key);
      keys.clear();
    };
  }, [client, destroy]);

  return useCallback(
    (branchId: string, options?: { boardId?: string }): Promise<void> => {
      if (!client) return Promise.reject(new Error('Not connected to daemon'));
      // Even after timeout, another click must not replay an uncertain mutation.
      const existing = operations.current.get(branchId);
      if (existing) return existing.promise;

      const key = `unarchive:${branchId}`;
      toastKeys.current.add(key);
      showLoading('Unarchiving branch...', { key });
      let disposed = false;
      let resolve!: () => void;
      let reject!: (error: unknown) => void;
      const promise = new Promise<void>((yes, no) => {
        resolve = yes;
        reject = no;
      });
      const timer = setTimeout(() => {
        showWarning(UNKNOWN_OUTCOME, { key, duration: 10 });
        // Settings must not optimistically clear archive state on uncertainty.
        reject(new Error(UNKNOWN_OUTCOME));
      }, ACKNOWLEDGEMENT_WAIT_MS);
      operations.current.set(branchId, {
        promise,
        dispose: () => {
          disposed = true;
          clearTimeout(timer);
          reject(new Error('Unarchive acknowledgement wait cancelled'));
        },
      });

      const acknowledge = async () => {
        try {
          await client.service(`branches/${branchId}/unarchive`).create(options || {});
          if (disposed) return;
          showSuccess(
            'Unarchive accepted; wait for filesystem recovery to finish before starting work. Refresh the page to check status.',
            { key }
          );
          resolve();
        } catch (error) {
          if (disposed) return;
          if (
            isTransientConnectionError(error) ||
            (error instanceof Error && error.message === 'socket has been disconnected')
          ) {
            showWarning(UNKNOWN_OUTCOME, { key, duration: 10 });
          } else {
            showError(
              `Unarchive request returned an error: ${error instanceof Error ? error.message : String(error)}. Refresh the page to check current status.`,
              { key }
            );
          }
          reject(error);
        } finally {
          clearTimeout(timer);
          if (!disposed) operations.current.delete(branchId);
        }
      };
      void acknowledge();
      return promise;
    },
    [client, showLoading, showSuccess, showError, showWarning]
  );
}
