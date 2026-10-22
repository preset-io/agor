import { BOARD_FILE_KIND_LABELS, type BoardFileItem, type BoardFileKind } from '@agor-live/client';
import {
  AppstoreOutlined,
  FileTextOutlined,
  PaperClipOutlined,
  PullRequestOutlined,
} from '@ant-design/icons';
import type { GlobalToken } from 'antd';
import type React from 'react';

/** The type name people see: Artifact, Document, App and pull request, Upload. */
export const boardFileTypeLabel = (kind: BoardFileKind) => BOARD_FILE_KIND_LABELS[kind];

export const BOARD_FILE_ICONS: Record<BoardFileKind, React.ReactNode> = {
  artifact: <AppstoreOutlined />,
  document: <FileTextOutlined />,
  app: <PullRequestOutlined />,
  upload: <PaperClipOutlined />,
};

/** Each type's icon colour, as in the mock: artifacts teal, documents blue, apps purple. */
export function boardFileIconColor(kind: BoardFileKind, token: GlobalToken): string {
  switch (kind) {
    case 'artifact':
      return token.colorPrimary;
    case 'document':
      return token.colorInfo;
    case 'app':
      return token.purple;
    case 'upload':
      return token.colorTextSecondary;
  }
}

/** 2 KB, 1.4 MB: file sizes for people, not bytes. */
export function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

/** The short file type: the extension, else the media subtype, upper case. */
export function uploadFileType(item: Pick<BoardFileItem, 'name' | 'mime_type'>): string {
  const extension = item.name.includes('.') ? item.name.split('.').pop() : undefined;
  if (extension && extension.length <= 5) return extension.toUpperCase();
  return (item.mime_type?.split('/')[1] ?? 'File').split(/[;+]/)[0].toUpperCase();
}

/** The status word (A14): Live, Draft, Shared, Ready to review; an upload's type and size. */
export function boardFileStatus(item: BoardFileItem): string | undefined {
  if (item.kind === 'upload') {
    return item.size_bytes === undefined
      ? uploadFileType(item)
      : `${uploadFileType(item)}, ${formatFileSize(item.size_bytes)}`;
  }
  return item.status;
}
