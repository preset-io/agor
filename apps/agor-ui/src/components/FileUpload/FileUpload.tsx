import { PaperClipOutlined, UploadOutlined } from '@ant-design/icons';
import { Button, Checkbox, Input, Modal, Space, Typography, Upload } from 'antd';
import type { RcFile, UploadFile } from 'antd/es/upload/interface';
import type React from 'react';
import { forwardRef, useCallback, useEffect, useRef, useState } from 'react';
import { useThemedMessage } from '../../utils/message';
import { uploadFilesToSession } from './upload';

const { TextArea } = Input;
const { Text } = Typography;

const DEFAULT_AGENT_UPLOAD_MESSAGE =
  'Please review the attached file(s) and use them as context for this task.';

export type { UploadDestination, UploadedFile } from './upload';

export interface FileUploadProps {
  sessionId: string;
  daemonUrl: string;
  open: boolean;
  onClose: () => void;
  onNotifyAgent: (message: string, attachmentTokens: string[]) => Promise<void>;
  initialFiles?: File[]; // Allow passing dropped files
}

export const FileUpload: React.FC<FileUploadProps> = ({
  sessionId,
  daemonUrl,
  open,
  onClose,
  onNotifyAgent,
  initialFiles,
}) => {
  const { showSuccess, showWarning, showError } = useThemedMessage();
  const [fileList, setFileList] = useState<UploadFile[]>([]);
  const [notifyAgent, setNotifyAgent] = useState(true);
  const [agentMessage, setAgentMessage] = useState(DEFAULT_AGENT_UPLOAD_MESSAGE);
  const [uploading, setUploading] = useState(false);

  // Mirror fileList in a ref so cleanup (unmount/reset) can revoke object URLs
  // without re-running effects on every keystroke.
  const fileListRef = useRef<UploadFile[]>([]);
  fileListRef.current = fileList;

  // Build an UploadFile, generating a local thumbnail URL for images so Ant
  // Design's picture list can render a preview without any server round-trip.
  const buildUploadFile = useCallback((file: File): UploadFile => {
    const rc = file as RcFile; // Ant Design's extended File type
    const isImage = file.type.startsWith('image/');
    return {
      uid: rc.uid || `${Date.now()}-${file.name}`,
      name: file.name,
      status: 'done',
      originFileObj: rc,
      thumbUrl: isImage ? URL.createObjectURL(file) : undefined,
    };
  }, []);

  const revokeThumb = useCallback((file: UploadFile) => {
    if (file.thumbUrl?.startsWith('blob:')) {
      URL.revokeObjectURL(file.thumbUrl);
    }
  }, []);

  const resetFileList = useCallback(() => {
    fileListRef.current.forEach(revokeThumb);
    setFileList([]);
  }, [revokeThumb]);

  // Revoke any outstanding object URLs when the modal unmounts.
  useEffect(() => () => fileListRef.current.forEach(revokeThumb), [revokeThumb]);

  // Populate fileList when initialFiles are provided (replaces existing list to prevent duplicates)
  useEffect(() => {
    if (initialFiles && initialFiles.length > 0 && open) {
      fileListRef.current.forEach(revokeThumb);
      setFileList(initialFiles.map(buildUploadFile)); // Replace to prevent duplicate accumulation
    }
  }, [initialFiles, open, buildUploadFile, revokeThumb]);

  const handleUpload = async () => {
    if (fileList.length === 0) {
      showWarning('Please select at least one file');
      return;
    }

    setUploading(true);

    try {
      const files = fileList.flatMap((file) => {
        if (file.originFileObj) return [file.originFileObj as File];
        console.warn('[FileUpload] File missing originFileObj:', file.name);
        return [];
      });

      const result = await uploadFilesToSession({
        sessionId,
        daemonUrl,
        files,
      });

      if (notifyAgent) {
        const attachmentTokens = result.files.flatMap((file) =>
          file.attachmentToken ? [file.attachmentToken] : []
        );
        if (attachmentTokens.length !== result.files.length) {
          throw new Error('Uploaded files could not be associated with the agent task');
        }
        await onNotifyAgent(agentMessage, attachmentTokens);
      }

      showSuccess(`Uploaded ${result.files.length} file(s) successfully`);

      // Reset and close
      resetFileList();
      setNotifyAgent(true);
      setAgentMessage(DEFAULT_AGENT_UPLOAD_MESSAGE);
      onClose();
    } catch (error) {
      console.error('Upload error:', error);
      showError(error instanceof Error ? error.message : 'Failed to upload files');
    } finally {
      setUploading(false);
    }
  };

  const handleCancel = () => {
    resetFileList();
    setNotifyAgent(true);
    setAgentMessage(DEFAULT_AGENT_UPLOAD_MESSAGE);
    onClose();
  };

  return (
    <Modal
      title="Upload File(s)"
      open={open}
      onCancel={handleCancel}
      onOk={handleUpload}
      confirmLoading={uploading}
      okText="Upload"
      cancelText="Cancel"
      width={600}
    >
      <Space orientation="vertical" style={{ width: '100%' }} size="large">
        {/* File selector */}
        <Upload
          multiple
          listType="picture"
          fileList={fileList}
          beforeUpload={(file) => {
            setFileList((prev) => [...prev, buildUploadFile(file)]);
            return false; // Prevent auto upload
          }}
          onRemove={(file) => {
            revokeThumb(file);
            setFileList((prev) => prev.filter((f) => f.uid !== file.uid));
          }}
        >
          <Button icon={<UploadOutlined />}>Select Files</Button>
        </Upload>

        <Text type="secondary" style={{ fontSize: '12px' }}>
          When notified, files are securely attached to the agent task.
        </Text>

        {/* Notify agent option */}
        <div>
          <Checkbox checked={notifyAgent} onChange={(e) => setNotifyAgent(e.target.checked)}>
            Notify the agent about this file
          </Checkbox>

          {notifyAgent && (
            <div style={{ marginTop: 8 }}>
              <TextArea
                value={agentMessage}
                onChange={(e) => setAgentMessage(e.target.value)}
                placeholder="Message to agent"
                autoSize={{ minRows: 2, maxRows: 4 }}
              />
            </div>
          )}
        </div>
      </Space>
    </Modal>
  );
};

/**
 * File upload button component
 */
export interface FileUploadButtonProps {
  onClick: () => void;
  disabled?: boolean;
  size?: 'small' | 'middle' | 'large';
  title?: string;
}

export const FileUploadButton = forwardRef<HTMLButtonElement, FileUploadButtonProps>(
  ({ onClick, disabled, size = 'middle', title = 'Upload files' }, ref) => {
    return (
      <Button
        ref={ref}
        icon={<PaperClipOutlined />}
        onClick={onClick}
        disabled={disabled}
        size={size}
        title={title}
      />
    );
  }
);
