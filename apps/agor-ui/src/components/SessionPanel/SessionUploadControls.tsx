import { UploadOutlined } from '@ant-design/icons';
import { Button, Tooltip } from 'antd';
import type React from 'react';
import { FileUploadButton } from '../FileUpload';

interface SessionUploadControlsProps {
  connectionDisabled: boolean;
  composerImageUploading: boolean;
  onAttachFiles: () => void;
  onOpenAdvancedUpload: () => void;
}

export const SessionUploadControls: React.FC<SessionUploadControlsProps> = ({
  connectionDisabled,
  composerImageUploading,
  onAttachFiles,
  onOpenAdvancedUpload,
}) => {
  const uploadDisabled = connectionDisabled || composerImageUploading;

  return (
    <>
      <Tooltip
        title={
          connectionDisabled
            ? 'Disconnected from daemon'
            : composerImageUploading
              ? 'Uploading files…'
              : 'Attach files'
        }
      >
        <FileUploadButton onClick={onAttachFiles} disabled={uploadDisabled} title="Attach files" />
      </Tooltip>
      <Tooltip
        title={
          connectionDisabled
            ? 'Disconnected from daemon'
            : composerImageUploading
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
