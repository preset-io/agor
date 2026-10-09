import type { AgorClient } from '@agor-live/client';
import { useCallback, useEffect, useRef } from 'react';
import { isTransientConnectionError } from '../utils/authErrors';
import {
  CLIENT_NOT_CONNECTED_ERROR,
  formatActionError,
  isAlreadyDoneError,
  isInFlightConnectionLossError,
  notConnectedMessage,
} from '../utils/connectionErrors';
import { useThemedMessage } from '../utils/message';

const ACKNOWLEDGEMENT_WAIT_MS = 30_000;
const ACTION = 'unarchive the branch';
const UNKNOWN_OUTCOME = `The connection to Agor dropped before this was confirmed. If it didn't go through, try to ${ACTION} again once the connection is back.`;
const UNARCHIVED = 'Branch unarchived. Agor is restoring its files.';
/** The UI wait ran out on a live connection, so no cause is claimed. */
const NOT_CONFIRMED_YET =
  "Agor hasn't confirmed the unarchive yet. Refresh to check the branch before you try again.";

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
      if (!client) {
        showError(notConnectedMessage(ACTION));
        return Promise.reject(new Error(CLIENT_NOT_CONNECTED_ERROR));
      }
      // Even after timeout, another click must not replay an uncertain mutation.
      const existing = operations.current.get(branchId);
      if (existing) return existing.promise;

      const key = `unarchive:${branchId}`;
      toastKeys.current.add(key);
      showLoading('Unarchiving the branch…', { key });
      let disposed = false;
      let resolve!: () => void;
      let reject!: (error: unknown) => void;
      const promise = new Promise<void>((yes, no) => {
        resolve = yes;
        reject = no;
      });
      const timer = setTimeout(() => {
        showWarning(NOT_CONFIRMED_YET, { key, duration: 0 });
        // Settings must not optimistically clear archive state on uncertainty.
        reject(new Error(NOT_CONFIRMED_YET));
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
          showSuccess(UNARCHIVED, { key });
          resolve();
        } catch (error) {
          if (disposed) return;
          if (isAlreadyDoneError(ACTION, error)) {
            showSuccess(UNARCHIVED, { key });
            resolve();
            return;
          }
          if (isTransientConnectionError(error) || isInFlightConnectionLossError(error)) {
            showWarning(UNKNOWN_OUTCOME, { key, duration: 0 });
          } else {
            showError(formatActionError(ACTION, error, { idempotent: true }), { key });
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
