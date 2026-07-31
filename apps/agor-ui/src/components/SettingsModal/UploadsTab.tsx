import { DeleteOutlined, DownloadOutlined, EyeOutlined } from '@ant-design/icons';
import { Button, Empty, Popconfirm, Space, Table, Tooltip, Typography } from 'antd';
import { useCallback, useEffect, useState } from 'react';
import { getDaemonUrl } from '../../config/daemon';
import { getAuthHeaders } from '../../utils/authHeaders';
import { useThemedMessage } from '../../utils/message';
import { SettingsActionGroup } from './SettingsActionGroup';

interface UploadRow {
  ref: string;
  displayName: string;
  mimeType: string;
  size: number;
  provenance: string;
  createdAt: string;
  expiresAt: string | null;
}

function humanBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MiB`;
}

function uploadsUrl(path = ''): string {
  return `${getDaemonUrl().replace(/\/$/, '')}/uploads${path}`;
}

async function fetchContent(upload: UploadRow): Promise<Blob> {
  const response = await fetch(uploadsUrl(`/${encodeURIComponent(upload.ref)}/content`), {
    headers: getAuthHeaders(),
  });
  if (!response.ok) throw new Error('Upload is unavailable');
  return response.blob();
}

export function UploadsTab() {
  const { showError } = useThemedMessage();
  const [uploads, setUploads] = useState<UploadRow[]>([]);
  const [loading, setLoading] = useState(false);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const response = await fetch(uploadsUrl(), { headers: getAuthHeaders() });
      if (!response.ok) throw new Error('Unable to load uploads');
      const body = (await response.json()) as { uploads?: UploadRow[] };
      setUploads([...(body.uploads ?? [])].sort((a, b) => b.createdAt.localeCompare(a.createdAt)));
    } catch (error) {
      showError(error instanceof Error ? error.message : 'Unable to load uploads');
    } finally {
      setLoading(false);
    }
  }, [showError]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const openBlob = async (upload: UploadRow, download: boolean) => {
    try {
      const url = URL.createObjectURL(await fetchContent(upload));
      const anchor = document.createElement('a');
      anchor.href = url;
      if (download) anchor.download = upload.displayName;
      else anchor.target = '_blank';
      anchor.rel = 'noopener noreferrer';
      anchor.click();
      setTimeout(() => URL.revokeObjectURL(url), 60_000);
    } catch (error) {
      showError(error instanceof Error ? error.message : 'Upload is unavailable');
    }
  };

  const remove = async (upload: UploadRow) => {
    try {
      const response = await fetch(uploadsUrl(`/${encodeURIComponent(upload.ref)}`), {
        method: 'DELETE',
        headers: getAuthHeaders(),
      });
      if (!response.ok) throw new Error('Unable to delete upload');
      setUploads((current) => current.filter((item) => item.ref !== upload.ref));
    } catch (error) {
      showError(error instanceof Error ? error.message : 'Unable to delete upload');
    }
  };

  const rename = async (upload: UploadRow, displayName: string) => {
    try {
      const response = await fetch(uploadsUrl(`/${encodeURIComponent(upload.ref)}`), {
        method: 'PATCH',
        headers: { ...getAuthHeaders(), 'Content-Type': 'application/json' },
        body: JSON.stringify({ displayName }),
      });
      if (!response.ok) throw new Error('Unable to rename upload');
      setUploads((current) =>
        current.map((item) => (item.ref === upload.ref ? { ...item, displayName } : item))
      );
    } catch (error) {
      showError(error instanceof Error ? error.message : 'Unable to rename upload');
    }
  };

  return (
    <>
      <Typography.Paragraph type="secondary">
        Uploads are immutable and expire after the configured retention period. Preview loads the
        original file; Agor does not generate thumbnails.
      </Typography.Paragraph>
      <Table
        rowKey="ref"
        size="small"
        loading={loading}
        dataSource={uploads}
        locale={{ emptyText: <Empty description="No uploads" /> }}
        pagination={{ pageSize: 25, showSizeChanger: false }}
        columns={[
          {
            title: 'File',
            dataIndex: 'displayName',
            render: (name: string, row) => (
              <Typography.Text editable={{ onChange: (value) => void rename(row, value) }}>
                {name}
              </Typography.Text>
            ),
          },
          { title: 'Size', dataIndex: 'size', render: humanBytes },
          {
            title: 'Uploaded',
            dataIndex: 'createdAt',
            defaultSortOrder: 'descend',
            sorter: (a, b) => a.createdAt.localeCompare(b.createdAt),
            render: (value: string, row) => (
              <Tooltip
                title={
                  <Space orientation="vertical" size={0}>
                    <span>Uploaded: {new Date(value).toLocaleString()}</span>
                    <span>
                      Expires: {row.expiresAt ? new Date(row.expiresAt).toLocaleString() : 'Never'}
                    </span>
                    <span>Type: {row.mimeType}</span>
                    <span>Source: {row.provenance}</span>
                  </Space>
                }
              >
                <Typography.Text>{new Date(value).toLocaleDateString()}</Typography.Text>
              </Tooltip>
            ),
          },
          {
            title: '',
            key: 'actions',
            render: (_, row) => (
              <SettingsActionGroup>
                <Tooltip title="Preview upload">
                  <Button
                    type="text"
                    size="small"
                    aria-label={`Preview ${row.displayName}`}
                    icon={<EyeOutlined />}
                    onClick={() => void openBlob(row, false)}
                  />
                </Tooltip>
                <Tooltip title="Download upload">
                  <Button
                    type="text"
                    size="small"
                    aria-label={`Download ${row.displayName}`}
                    icon={<DownloadOutlined />}
                    onClick={() => void openBlob(row, true)}
                  />
                </Tooltip>
                <Popconfirm
                  title="Delete this upload?"
                  description="Conversation history will show it as unavailable."
                  onConfirm={() => void remove(row)}
                >
                  <Tooltip title="Delete upload">
                    <Button
                      type="text"
                      danger
                      size="small"
                      aria-label={`Delete ${row.displayName}`}
                      icon={<DeleteOutlined />}
                    />
                  </Tooltip>
                </Popconfirm>
              </SettingsActionGroup>
            ),
          },
        ]}
      />
    </>
  );
}
