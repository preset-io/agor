import { PaperClipOutlined, UploadOutlined } from '@ant-design/icons';
import { App, Button, Checkbox, Input, Modal, Radio, Space, Typography, Upload } from 'antd';
import type { RcFile, UploadFile } from 'antd/es/upload/interface';
import type React from 'react';
import { useEffect, useState } from 'react';
import { ACCESS_TOKEN_KEY } from '../../utils/tokenRefresh';

const { TextArea } = Input;
const { Text } = Typography;

// Debug logging only in development
const DEBUG_UPLOAD = import.meta.env.DEV;

export type UploadDestination = 'worktree' | 'temp' | 'global';

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
  const { message: antMessage } = App.useApp();
  const [fileList, setFileList] = useState<UploadFile[]>([]);
  const [destination, setDestination] = useState<UploadDestination>('worktree');
  const [notifyAgent, setNotifyAgent] = useState(false);
  const [agentMessage, setAgentMessage] = useState('Please review this file: {filepath}');
  const [uploading, setUploading] = useState(false);

  // Populate fileList when initialFiles are provided (replaces existing list to prevent duplicates)
  useEffect(() => {
    if (initialFiles && initialFiles.length > 0 && open) {
      const uploadFiles: UploadFile[] = initialFiles.map((file) => ({
        uid: `${Date.now()}-${file.name}`,
        name: file.name,
        status: 'done',
        originFileObj: file as RcFile, // Cast File to RcFile (Ant Design's extended File type)
      }));
      setFileList(uploadFiles); // Replace instead of append to prevent duplicate accumulation
    }
  }, [initialFiles, open]);

  const handleUpload = async () => {
    if (fileList.length === 0) {
      antMessage.warning('Please select at least one file');
      return;
    }

    setUploading(true);

    try {
      const formData = new FormData();

      if (DEBUG_UPLOAD) {
        console.log('[FileUpload] Preparing FormData:', {
          fileListLength: fileList.length,
          files: fileList.map((f) => ({
            name: f.name,
            hasOriginFileObj: !!f.originFileObj,
            type: f.type,
          })),
        });
      }

      fileList.forEach((file) => {
        if (file.originFileObj) {
          formData.append('files', file.originFileObj);
          if (DEBUG_UPLOAD) console.log('[FileUpload] Added file to FormData:', file.name);
        } else {
          console.warn('[FileUpload] File missing originFileObj:', file.name);
        }
      });
      // Note: destination is sent as query param because multer can't access req.body
      // during the destination callback
      formData.append('notifyAgent', String(notifyAgent));
      formData.append('message', agentMessage);

      const uploadUrl = `${daemonUrl}/sessions/${sessionId}/upload?destination=${encodeURIComponent(destination)}`;
      if (DEBUG_UPLOAD) {
        console.log('[FileUpload] Starting upload:', {
          url: uploadUrl,
          sessionId: sessionId.substring(0, 8),
          fileCount: fileList.length,
          destination,
          notifyAgent,
        });
      }

      // Get JWT token from localStorage (same as Feathers client)
      const accessToken = localStorage.getItem(ACCESS_TOKEN_KEY);
      const headers: HeadersInit = {};

      if (accessToken) {
        headers.Authorization = `Bearer ${accessToken}`;
        if (DEBUG_UPLOAD) console.log('[FileUpload] Added Authorization header with token');
      } else {
        console.warn('[FileUpload] No access token found in localStorage');
      }

      const response = await fetch(uploadUrl, {
        method: 'POST',
        headers,
        body: formData,
        credentials: 'include', // Include cookies for session
      });

      if (DEBUG_UPLOAD) {
        console.log('[FileUpload] Response received:', {
          status: response.status,
          ok: response.ok,
        });
      }

      if (!response.ok) {
        const errorText = await response.text();
        if (DEBUG_UPLOAD) {
          console.error('[FileUpload] Upload failed:', {
            status: response.status,
            statusText: response.statusText,
            body: errorText,
          });
        }
        let error: { error?: string } = {};
        try {
          error = JSON.parse(errorText);
        } catch {
          error = { error: errorText || 'Upload failed' };
        }
        throw new Error(error.error || 'Upload failed');
      }

      const result = await response.json();
      if (DEBUG_UPLOAD) console.log('[FileUpload] Upload successful:', result);

      // Show success message with final filename(s) so user knows what to reference
      if (result.files.length === 1) {
        antMessage.success(`Uploaded as: ${result.files[0].filename}`);
      } else {
        antMessage.success(`Uploaded ${result.files.length} files successfully`);
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
      setFileList([]);
      setNotifyAgent(false);
      setAgentMessage('Please review this file: {filepath}');
      onClose();
    } catch (error) {
      console.error('Upload error:', error);
      antMessage.error(error instanceof Error ? error.message : 'Failed to upload files');
    } finally {
      setUploading(false);
    }
  };

  const handleCancel = () => {
    setFileList([]);
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
      <Space direction="vertical" style={{ width: '100%' }} size="large">
        {/* File selector */}
        <Upload
          multiple
          fileList={fileList}
          beforeUpload={(file) => {
            // Create UploadFile object with originFileObj preserved
            const uploadFile: UploadFile = {
              uid: file.uid || `${Date.now()}-${file.name}`,
              name: file.name,
              status: 'done',
              originFileObj: file,
            };
            setFileList((prev) => [...prev, uploadFile]);
            return false; // Prevent auto upload
          }}
          onRemove={(file) => {
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
            <Space direction="vertical">
              <Radio value="worktree">
                <Space direction="vertical" size={0}>
                  <Text>Worktree (.agor/uploads/)</Text>
                  <Text type="secondary" style={{ fontSize: '12px' }}>
                    Default - Agent-accessible, can be committed
                  </Text>
                </Space>
              </Radio>
              <Radio value="temp">
                <Space direction="vertical" size={0}>
                  <Text>Temp folder</Text>
                  <Text type="secondary" style={{ fontSize: '12px' }}>
                    Ephemeral, auto-cleanup
                  </Text>
                </Space>
              </Radio>
              <Radio value="global">
                <Space direction="vertical" size={0}>
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

export const FileUploadButton: React.FC<FileUploadButtonProps> = ({
  onClick,
  disabled,
  size = 'middle',
}) => {
  return (
    <Button
      icon={<PaperClipOutlined />}
      onClick={onClick}
      disabled={disabled}
      size={size}
      type="text"
      title="Upload files"
    />
  );
};
