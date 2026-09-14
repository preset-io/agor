import type { ArtifactCompilationStatus, ArtifactSandpackReport } from '@agor/core/types';
import { useSandpack } from '@codesandbox/sandpack-react';
import { useEffect, useRef, useState } from 'react';
import { getDaemonUrl } from '@/config/daemon';
import { getAuthHeaders } from '@/utils/authHeaders';

const SANDPACK_ERROR_THROTTLE_MS = 1000;

/** Reports the existing preview's errors/completion, without creating another client/iframe. */
export function ArtifactSandpackErrorReporter({
  artifactId,
  contentHash,
}: {
  artifactId: string;
  contentHash?: string;
}) {
  const { sandpack, listen } = useSandpack();
  const [compilation, setCompilation] = useState<{
    contentHash?: string;
    status: ArtifactCompilationStatus;
  }>({ contentHash, status: 'pending' });
  const lastSentRef = useRef<string | null>(null);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pendingSendRef = useRef<(() => void) | null>(null);

  useEffect(() => {
    setCompilation({ contentHash, status: 'pending' });
  }, [contentHash]);

  useEffect(() => {
    // Sandpack can replace `listen` during an ordinary provider update. Renew
    // the subscription without discarding completion for the current render.
    return listen((message) => {
      if (message.type === 'start') {
        setCompilation({ contentHash, status: 'compiling' });
      } else if (message.type === 'done') {
        // Sandpack's protocol spells this `compilatonError`. A connected client
        // (or provider status `running`) alone says nothing about compilation.
        setCompilation({
          contentHash,
          status: message.compilatonError === false ? 'success' : 'error',
        });
      }
    });
  }, [listen, contentHash]);

  useEffect(() => {
    if (sandpack.status !== 'running') {
      setCompilation({ contentHash, status: 'pending' });
    }
  }, [sandpack.status, contentHash]);

  const compilationStatus: ArtifactCompilationStatus = sandpack.error
    ? 'error'
    : sandpack.status !== 'running' || compilation.contentHash !== contentHash
      ? 'pending'
      : compilation.status;

  useEffect(() => {
    const payload: ArtifactSandpackReport = {
      error: sandpack.error
        ? {
            message: sandpack.error.message,
            ...(sandpack.error.title ? { title: sandpack.error.title } : {}),
            ...(sandpack.error.path ? { path: sandpack.error.path } : {}),
            ...(sandpack.error.line != null ? { line: sandpack.error.line } : {}),
            ...(sandpack.error.column != null ? { column: sandpack.error.column } : {}),
          }
        : null,
      status: sandpack.status,
      compilation_status: compilationStatus,
      content_hash: contentHash,
    };
    const stateKey = `${artifactId}\0${JSON.stringify(payload)}`;
    if (stateKey === lastSentRef.current) return;

    const sendReport = () => {
      lastSentRef.current = stateKey;
      pendingSendRef.current = null;
      fetch(`${getDaemonUrl()}/artifacts/${artifactId}/sandpack-error`, {
        method: 'POST',
        headers: getAuthHeaders(),
        body: JSON.stringify(payload),
      }).catch(() => {});
    };

    pendingSendRef.current = sendReport;
    timerRef.current = setTimeout(() => {
      timerRef.current = null;
      sendReport();
    }, SANDPACK_ERROR_THROTTLE_MS);

    return () => {
      if (timerRef.current) {
        clearTimeout(timerRef.current);
        timerRef.current = null;
        pendingSendRef.current?.();
      }
    };
  }, [sandpack.error, sandpack.status, compilationStatus, artifactId, contentHash]);

  return null;
}
