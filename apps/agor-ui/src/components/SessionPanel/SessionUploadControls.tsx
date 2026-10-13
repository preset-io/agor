import { UploadOutlined } from '@ant-design/icons';
import { Button, Tooltip } from 'antd';
import type React from 'react';
import { LOST_CONNECTION_TOOLTIP } from '../../utils/connectionErrors';
import { FileUploadButton } from '../FileUpload';

interface SessionUploadControlsProps {
  connectionDisabled: boolean;
  composerAttachmentUploading: boolean;
  onAttachFiles: () => void;
  onOpenAdvancedUpload: () => void;
}

export const SessionUploadControls: React.FC<SessionUploadControlsProps> = ({
  connectionDisabled,
  composerAttachmentUploading,
  onAttachFiles,
  onOpenAdvancedUpload,
}) => {
  const uploadDisabled = connectionDisabled || composerAttachmentUploading;

  return (
    <>
      <Tooltip
        title={
          connectionDisabled
            ? LOST_CONNECTION_TOOLTIP
            : composerAttachmentUploading
              ? 'Uploading files…'
              : 'Attach files'
        }
      >
        <FileUploadButton onClick={onAttachFiles} disabled={uploadDisabled} title="Attach files" />
      </Tooltip>
      <Tooltip
        title={
          connectionDisabled
            ? LOST_CONNECTION_TOOLTIP
            : composerAttachmentUploading
              ? 'Uploading files…'
              : 'Advanced upload'
        }
      >
        <Button
          aria-label="Advanced upload"
          icon={<UploadOutlined />}
          onClick={onOpenAdvancedUpload}
          disabled={uploadDisabled}
          title="Advanced upload"
        />
      </Tooltip>
    </>
  );
};
