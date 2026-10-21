import { type BoardFileItem, UPLOAD_PREVIEW_IMAGE_MIME_TYPES } from '@agor-live/client';
import { Flex, Skeleton, Typography, theme } from 'antd';
import { useEffect, useState } from 'react';
import { getDaemonUrl } from '../../config/daemon';
import { getAuthHeaders } from '../../utils/authHeaders';
import { formatFileSize, uploadFileType } from '../../utils/boardFiles';
import { UploadAttachmentLink } from '../MarkdownRenderer';

/** The upload's bytes as an object URL while shown, or null when they cannot be read. */
function useUploadImageUrl(ref: string, enabled: boolean) {
  const [state, setState] = useState<{ ref: string; url: string | null } | null>(null);
  useEffect(() => {
    if (!enabled) return;
    let url: string | null = null;
    let cancelled = false;
    fetch(`${getDaemonUrl().replace(/\/$/, '')}/uploads/${encodeURIComponent(ref)}/content`, {
      headers: getAuthHeaders(),
    })
      .then((response) => (response.ok ? response.blob() : null))
      .then((blob) => {
        if (cancelled) return;
        url = blob ? URL.createObjectURL(blob) : null;
        setState({ ref, url });
      })
      .catch(() => {
        if (!cancelled) setState({ ref, url: null });
      });
    return () => {
      cancelled = true;
      if (url) URL.revokeObjectURL(url);
    };
  }, [ref, enabled]);
  return state?.ref === ref ? state : null;
}

/**
 * An upload in the preview (A7): raster images inline; any other file shows its
 * name, type and size with the transcript's open and download control.
 */
export const UploadPreview: React.FC<{ uploadRef: string; item: BoardFileItem }> = ({
  uploadRef,
  item,
}) => {
  const { token } = theme.useToken();
  const isImage = UPLOAD_PREVIEW_IMAGE_MIME_TYPES.has((item.mime_type ?? '').toLowerCase());
  const image = useUploadImageUrl(uploadRef, isImage);
  const details = [
    uploadFileType(item),
    item.size_bytes !== undefined && formatFileSize(item.size_bytes),
  ]
    .filter(Boolean)
    .join(' · ');

  return (
    <Flex
      vertical
      gap={token.marginSM}
      style={{ padding: `${token.paddingSM}px ${token.paddingMD}px` }}
    >
      {isImage &&
        (image === null ? (
          <Skeleton.Image active style={{ width: '100%', height: 200 }} />
        ) : image.url ? (
          <img
            src={image.url}
            alt={item.name}
            style={{ maxWidth: '100%', height: 'auto', borderRadius: token.borderRadius }}
          />
        ) : (
          <Typography.Text type="secondary">This image could not be loaded.</Typography.Text>
        ))}
      <Flex vertical gap={token.marginXXS}>
        <Typography.Text strong>{item.name}</Typography.Text>
        <Typography.Text type="secondary">{details}</Typography.Text>
      </Flex>
      <div>
        <UploadAttachmentLink uploadRef={uploadRef}>{item.name}</UploadAttachmentLink>
      </div>
    </Flex>
  );
};
