import { PaperClipOutlined, UploadOutlined } from '@ant-design/icons';
import { Button, Checkbox, Input, Modal, Radio, Space, Typography, Upload } from 'antd';
import type { RcFile, UploadFile } from 'antd/es/upload/interface';
import type React from 'react';
import { forwardRef, useCallback, useEffect, useRef, useState } from 'react';
import { useThemedMessage } from '../../utils/message';
import { ACCESS_TOKEN_KEY } from '../../utils/tokenRefresh';

const { TextArea } = Input;
const { Text } = Typography;

export type UploadDestination = 'branch' | 'temp' | 'global';

export interface UploadedFile {
  filename: string;
  path: string;
  size: number;
  mimeType: string;
}

export interface FileUploadProps {
  sessionId: string;
  daemonUrl: string;
  open: boolean;
  onClose: () => void;
  onUploadComplete?: (files: UploadedFile[]) => void;
  onInsertMention?: (filepath: string) => void;
  initialFiles?: File[]; // Allow passing dropped files
}

export const FileUpload: React.FC<FileUploadProps> = ({
  sessionId,
  daemonUrl,
  open,
  onClose,
  onUploadComplete,
  onInsertMention,
  initialFiles,
}) => {
  const { showSuccess, showWarning, showError } = useThemedMessage();
  const [fileList, setFileList] = useState<UploadFile[]>([]);
  const [destination, setDestination] = useState<UploadDestination>('branch');
  const [notifyAgent, setNotifyAgent] = useState(true);
  const [agentMessage, setAgentMessage] = useState('Please review this file: {filepath}');
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
      const formData = new FormData();

      fileList.forEach((file) => {
        if (file.originFileObj) {
          formData.append('files', file.originFileObj);
        } else {
          console.warn('[FileUpload] File missing originFileObj:', file.name);
        }
      });
      // Note: destination is sent as query param because multer can't access req.body
      // during the destination callback
      formData.append('notifyAgent', String(notifyAgent));
      formData.append('message', agentMessage);

      const uploadUrl = `${daemonUrl}/sessions/${sessionId}/upload?destination=${encodeURIComponent(destination)}`;

      // Get JWT token from localStorage (same as Feathers client)
      const accessToken = localStorage.getItem(ACCESS_TOKEN_KEY);
      const headers: HeadersInit = {};

      if (accessToken) {
        headers.Authorization = `Bearer ${accessToken}`;
      } else {
        console.warn('[FileUpload] No access token found in localStorage');
      }

      const response = await fetch(uploadUrl, {
        method: 'POST',
        headers,
        body: formData,
        // No `credentials: 'include'` — the upload endpoint is Bearer-only
        // (cookie auth was removed to avoid CSRF). Sending credentials would
        // also force a non-wildcard Access-Control-Allow-Origin, which the
        // daemon's CORS layer answers with '*', breaking the preflight.
      });

      if (!response.ok) {
        const errorText = await response.text();
        let error: { error?: string } = {};
        try {
          error = JSON.parse(errorText);
        } catch {
          error = { error: errorText || 'Upload failed' };
        }
        throw new Error(error.error || 'Upload failed');
      }

      const result = await response.json();

      // Show success message with final filename(s) so user knows what to reference
      if (result.files.length === 1) {
        showSuccess(`Uploaded as: ${result.files[0].filename}`);
      } else {
        showSuccess(`Uploaded ${result.files.length} files successfully`);
      }

      // Call completion callback
      if (onUploadComplete) {
        onUploadComplete(result.files);
      }

      // If not notifying agent, optionally insert @filepath mention
      if (!notifyAgent && onInsertMention && result.files.length > 0) {
        // Insert first file path as mention
        const firstFile = result.files[0];
        // Quote paths with spaces to prevent breaking mention parser
        const mentionPath = firstFile.path.includes(' ') ? `"${firstFile.path}"` : firstFile.path;
        onInsertMention(mentionPath);
      }

      // Reset and close
      resetFileList();
      setNotifyAgent(false);
      setAgentMessage('Please review this file: {filepath}');
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
    setNotifyAgent(false);
    setAgentMessage('Please review this file: {filepath}');
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

        {/* Destination selector */}
        <div>
          <Text strong>Destination:</Text>
          <Radio.Group
            value={destination}
            onChange={(e) => setDestination(e.target.value)}
            style={{ marginTop: 8, display: 'block' }}
          >
            <Space orientation="vertical">
              <Radio value="branch">
                <Space orientation="vertical" size={0}>
                  <Text>Branch (.agor/uploads/)</Text>
                  <Text type="secondary" style={{ fontSize: '12px' }}>
                    Default - Agent-accessible, can be committed
                  </Text>
                </Space>
              </Radio>
              <Radio value="temp">
                <Space orientation="vertical" size={0}>
                  <Text>Temp folder</Text>
                  <Text type="secondary" style={{ fontSize: '12px' }}>
                    Ephemeral, auto-cleanup
                  </Text>
                </Space>
              </Radio>
              <Radio value="global">
                <Space orientation="vertical" size={0}>
                  <Text>Global (~/.agor/uploads/)</Text>
                  <Text type="secondary" style={{ fontSize: '12px' }}>
                    Shared across sessions
                  </Text>
                </Space>
              </Radio>
            </Space>
          </Radio.Group>
        </div>

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
                placeholder="Message to agent (use {filepath} for file path)"
                autoSize={{ minRows: 2, maxRows: 4 }}
              />
              <Text type="secondary" style={{ fontSize: '12px', marginTop: 4 }}>
                Use {'{filepath}'} to reference the uploaded file path
              </Text>
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
}

export const FileUploadButton = forwardRef<HTMLButtonElement, FileUploadButtonProps>(
  ({ onClick, disabled, size = 'middle' }, ref) => {
    return (
      <Button
        ref={ref}
        icon={<PaperClipOutlined />}
        onClick={onClick}
        disabled={disabled}
        size={size}
        title="Upload files"
      />
    );
  }
);
