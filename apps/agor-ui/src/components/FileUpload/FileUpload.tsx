import { PaperClipOutlined, UploadOutlined } from '@ant-design/icons';
import type { UploadFile } from 'antd';
import { App, Button, Checkbox, Input, Modal, Radio, Space, Typography, Upload } from 'antd';
import type React from 'react';
import { useState } from 'react';

const { TextArea } = Input;
const { Text } = Typography;

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
}

export const FileUpload: React.FC<FileUploadProps> = ({
  sessionId,
  daemonUrl,
  open,
  onClose,
  onUploadComplete,
  onInsertMention,
}) => {
  const { message: antMessage } = App.useApp();
  const [fileList, setFileList] = useState<UploadFile[]>([]);
  const [destination, setDestination] = useState<UploadDestination>('worktree');
  const [notifyAgent, setNotifyAgent] = useState(false);
  const [agentMessage, setAgentMessage] = useState('Please review this file: {filepath}');
  const [uploading, setUploading] = useState(false);

  const handleUpload = async () => {
    if (fileList.length === 0) {
      antMessage.warning('Please select at least one file');
      return;
    }

    setUploading(true);

    try {
      const formData = new FormData();
      fileList.forEach((file) => {
        if (file.originFileObj) {
          formData.append('files', file.originFileObj);
        }
      });
      formData.append('destination', destination);
      formData.append('notifyAgent', String(notifyAgent));
      formData.append('message', agentMessage);

      const response = await fetch(`${daemonUrl}/sessions/${sessionId}/upload`, {
        method: 'POST',
        body: formData,
        credentials: 'include', // Include cookies for authentication
      });

      if (!response.ok) {
        const error = await response.json();
        throw new Error(error.error || 'Upload failed');
      }

      const result = await response.json();

      antMessage.success(`Uploaded ${result.files.length} file(s) successfully`);

      // Call completion callback
      if (onUploadComplete) {
        onUploadComplete(result.files);
      }

      // If not notifying agent, optionally insert @filepath mention
      if (!notifyAgent && onInsertMention && result.files.length > 0) {
        // Insert first file path as mention
        const firstFile = result.files[0];
        onInsertMention(firstFile.path);
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
            setFileList((prev) => [...prev, file as UploadFile]);
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
