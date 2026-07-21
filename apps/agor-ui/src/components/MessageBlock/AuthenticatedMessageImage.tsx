import type { UrlImageContentBlock } from '@agor-live/client';
import { Image, Typography } from 'antd';
import { useEffect, useRef, useState } from 'react';
import { getDaemonUrl } from '../../config/daemon';
import { ACCESS_TOKEN_KEY } from '../../utils/tokenRefresh';

export function AuthenticatedMessageImage({ image }: { image: UrlImageContentBlock }) {
  const [blobUrl, setBlobUrl] = useState<string>();
  const [failed, setFailed] = useState(false);
  const blobUrlRef = useRef<string | undefined>(undefined);

  useEffect(() => {
    const controller = new AbortController();
    let active = true;
    const accessToken = localStorage.getItem(ACCESS_TOKEN_KEY);
    if (!accessToken) {
      setFailed(true);
      return () => controller.abort();
    }

    setFailed(false);
    fetch(`${getDaemonUrl()}${image.url}`, {
      headers: { Authorization: `Bearer ${accessToken}` },
      signal: controller.signal,
    })
      .then((response) => {
        if (!response.ok) throw new Error('Image unavailable');
        return response.blob();
      })
      .then((blob) => {
        if (!active) return;
        blobUrlRef.current = URL.createObjectURL(blob);
        setBlobUrl(blobUrlRef.current);
      })
      .catch((error) => {
        if (!(error instanceof DOMException && error.name === 'AbortError')) setFailed(true);
      });

    return () => {
      active = false;
      controller.abort();
      if (blobUrlRef.current) URL.revokeObjectURL(blobUrlRef.current);
      blobUrlRef.current = undefined;
    };
  }, [image.url]);

  if (failed) return <Typography.Text type="secondary">Image unavailable</Typography.Text>;
  if (!blobUrl) return null;

  return (
    <Image
      src={blobUrl}
      alt={image.filename ?? 'Uploaded image'}
      width={160}
      height={120}
      style={{ objectFit: 'cover' }}
      preview
      onError={() => {
        URL.revokeObjectURL(blobUrl);
        blobUrlRef.current = undefined;
        setBlobUrl(undefined);
        setFailed(true);
      }}
    />
  );
}
