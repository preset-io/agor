import { DeleteOutlined, DownloadOutlined, EyeOutlined } from '@ant-design/icons';
import { Button, Empty, message, Popconfirm, Space, Table, Tag, Typography } from 'antd';
import { useCallback, useEffect, useState } from 'react';
import { getAuthHeaders } from '../../utils/authHeaders';

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

async function fetchContent(upload: UploadRow): Promise<Blob> {
  const response = await fetch(`/uploads/${encodeURIComponent(upload.ref)}/content`, {
    headers: getAuthHeaders(),
  });
  if (!response.ok) throw new Error('Upload is unavailable');
  return response.blob();
}

export function UploadsTab() {
  const [uploads, setUploads] = useState<UploadRow[]>([]);
  const [loading, setLoading] = useState(false);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const response = await fetch('/uploads', { headers: getAuthHeaders() });
      if (!response.ok) throw new Error('Unable to load uploads');
      const body = (await response.json()) as { uploads?: UploadRow[] };
      setUploads(body.uploads ?? []);
    } catch (error) {
      void message.error(error instanceof Error ? error.message : 'Unable to load uploads');
    } finally {
      setLoading(false);
    }
  }, []);

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
      void message.error(error instanceof Error ? error.message : 'Upload is unavailable');
    }
  };

  const remove = async (upload: UploadRow) => {
    const response = await fetch(`/uploads/${encodeURIComponent(upload.ref)}`, {
      method: 'DELETE',
      headers: getAuthHeaders(),
    });
    if (!response.ok) {
      void message.error('Unable to delete upload');
      return;
    }
    setUploads((current) => current.filter((item) => item.ref !== upload.ref));
  };

  const rename = async (upload: UploadRow, displayName: string) => {
    const response = await fetch(`/uploads/${encodeURIComponent(upload.ref)}`, {
      method: 'PATCH',
      headers: getAuthHeaders(),
      body: JSON.stringify({ displayName }),
    });
    if (!response.ok) {
      void message.error('Unable to rename upload');
      return;
    }
    setUploads((current) =>
      current.map((item) => (item.ref === upload.ref ? { ...item, displayName } : item))
    );
  };

  return (
    <>
      <Typography.Paragraph type="secondary">
        Uploads are immutable and expire after the configured retention period. Preview loads the
        original file; Agor does not generate thumbnails.
      </Typography.Paragraph>
      <Table
        rowKey="ref"
        loading={loading}
        dataSource={uploads}
        locale={{ emptyText: <Empty description="No uploads" /> }}
        pagination={{ pageSize: 20 }}
        columns={[
          {
            title: 'File',
            dataIndex: 'displayName',
            render: (name: string, row) => (
              <Space direction="vertical" size={0}>
                <Typography.Text editable={{ onChange: (value) => void rename(row, value) }}>
                  {name}
                </Typography.Text>
                <Typography.Text type="secondary">{row.mimeType}</Typography.Text>
              </Space>
            ),
          },
          { title: 'Size', dataIndex: 'size', render: humanBytes },
          {
            title: 'Created',
            dataIndex: 'createdAt',
            render: (value: string) => new Date(value).toLocaleString(),
          },
          {
            title: 'Expires',
            dataIndex: 'expiresAt',
            render: (value: string | null) =>
              value ? new Date(value).toLocaleDateString() : <Tag>Never</Tag>,
          },
          {
            title: '',
            key: 'actions',
            render: (_, row) => (
              <Space>
                <Button
                  aria-label={`Preview ${row.displayName}`}
                  icon={<EyeOutlined />}
                  onClick={() => void openBlob(row, false)}
                />
                <Button
                  aria-label={`Download ${row.displayName}`}
                  icon={<DownloadOutlined />}
                  onClick={() => void openBlob(row, true)}
                />
                <Popconfirm
                  title="Delete this upload?"
                  description="Conversation history will show it as unavailable."
                  onConfirm={() => void remove(row)}
                >
                  <Button
                    danger
                    aria-label={`Delete ${row.displayName}`}
                    icon={<DeleteOutlined />}
                  />
                </Popconfirm>
              </Space>
            ),
          },
        ]}
      />
    </>
  );
}
