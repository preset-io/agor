import React from 'react';
import {
  fetchLinkImageObjectUrl,
  fetchLinkMarkdownText,
  type LinkPreviewKind,
} from './linkContent';

type PreviewResource = { kind: LinkPreviewKind; value: string };

export function useLinkPreviewResource(
  linkId: string | null | undefined,
  kind: LinkPreviewKind,
  enabled = true
) {
  const [resource, setResource] = React.useState<PreviewResource | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const [loading, setLoading] = React.useState(false);

  React.useEffect(() => {
    if (!linkId || !enabled) {
      setResource(null);
      setError(null);
      setLoading(false);
      return;
    }

    const controller = new AbortController();
    let objectUrl: string | null = null;
    let cancelled = false;
    setResource(null);
    setError(null);
    setLoading(true);

    const request =
      kind === 'image'
        ? fetchLinkImageObjectUrl(linkId, controller.signal).then((value) => {
            objectUrl = value;
            return { kind, value };
          })
        : fetchLinkMarkdownText(linkId, controller.signal).then((value) => ({ kind, value }));

    request
      .then((value) => {
        if (cancelled) {
          if (value.kind === 'image') URL.revokeObjectURL(value.value);
          return;
        }
        setResource(value);
      })
      .catch((reason) => {
        if (!cancelled && !(reason instanceof Error && reason.name === 'AbortError')) {
          setError(reason instanceof Error ? reason.message : 'Preview failed');
        }
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => {
      cancelled = true;
      controller.abort();
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [enabled, kind, linkId]);

  return { resource, error, loading };
}
