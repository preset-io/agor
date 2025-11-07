import type { Repo } from '@agor/core/types';
import { DeleteOutlined, EditOutlined, FolderOutlined, PlusOutlined } from '@ant-design/icons';
import { Button, Card, Empty, Form, Input, Modal, Popconfirm, Space, Tag, Typography } from 'antd';
import { useState } from 'react';

// Using Typography.Text directly to avoid DOM Text interface collision

// Utility: Extract slug from Git URL (org/repo format)
function extractSlugFromUrl(url: string): string {
  try {
    // Remove .git suffix if present
    const cleanUrl = url.endsWith('.git') ? url.slice(0, -4) : url;

    // Handle SSH format: git@github.com:org/repo
    if (cleanUrl.includes('@')) {
      const match = cleanUrl.match(/:([^/]+\/[^/]+)$/);
      if (match) {
        return match[1];
      }
    }

    // Handle HTTPS format: https://github.com/org/repo
    const match = cleanUrl.match(/[:/]([^/]+\/[^/]+)$/);
    if (match) {
      return match[1];
    }

    // Fallback: use last two path segments
    const segments = cleanUrl.split('/').filter(Boolean);
    if (segments.length >= 2) {
      return `${segments[segments.length - 2]}/${segments[segments.length - 1]}`;
    }

    return '';
  } catch {
    return '';
  }
}

interface ReposTableProps {
  repos: Repo[];
  onCreate?: (data: { url: string; slug: string; default_branch: string }) => void;
  onUpdate?: (repoId: string, updates: Partial<Repo>) => void;
  onDelete?: (repoId: string) => void;
}

export const ReposTable: React.FC<ReposTableProps> = ({ repos, onCreate, onUpdate, onDelete }) => {
  const [repoModalOpen, setRepoModalOpen] = useState(false);
  const [editingRepo, setEditingRepo] = useState<Repo | null>(null);
  const [repoForm] = Form.useForm();

  const isEditing = !!editingRepo;

  // Auto-extract slug when URL changes in repo form
  const handleUrlChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const url = e.target.value;
    if (url) {
      const slug = extractSlugFromUrl(url);
      if (slug) {
        repoForm.setFieldsValue({ slug });
      }
    }
  };

  const handleDeleteRepo = (repoId: string) => {
    onDelete?.(repoId);
  };

  const handleOpenCreateModal = () => {
    setEditingRepo(null);
    repoForm.resetFields();
    // Set default values for new repo
    repoForm.setFieldsValue({
      default_branch: 'main',
    });
    setRepoModalOpen(true);
  };

  const handleOpenEditModal = (repo: Repo) => {
    setEditingRepo(repo);
    repoForm.setFieldsValue({
      slug: repo.slug,
      default_branch: repo.default_branch || 'main',
    });
    setRepoModalOpen(true);
  };

  const handleSaveRepo = () => {
    repoForm.validateFields().then((values) => {
      if (isEditing && editingRepo) {
        // Update existing repo
        onUpdate?.(editingRepo.repo_id, {
          slug: values.slug,
          default_branch: values.default_branch,
        });
      } else {
        // Create new repo - close modal immediately, don't wait for clone
        onCreate?.({
          url: values.url,
          slug: values.slug,
          default_branch: values.default_branch,
        });
      }
      repoForm.resetFields();
      setEditingRepo(null);
      setRepoModalOpen(false);
    });
  };

  const handleCancelModal = () => {
    repoForm.resetFields();
    setEditingRepo(null);
    setRepoModalOpen(false);
  };

  return (
    <div>
      <div
        style={{
          marginBottom: 16,
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
        }}
      >
        <Typography.Text type="secondary">
          Clone and manage git repositories for your sessions.
        </Typography.Text>
        <Button type="primary" icon={<PlusOutlined />} onClick={handleOpenCreateModal}>
          New Repository
        </Button>
      </div>

      {repos.length === 0 && (
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            minHeight: 400,
          }}
        >
          <Empty description="No repositories yet">
            <Typography.Text type="secondary">
              Click "New Repository" to clone a git repository.
            </Typography.Text>
          </Empty>
        </div>
      )}

      {repos.length > 0 && (
        <Space direction="vertical" size={16} style={{ width: '100%' }}>
          {repos.map((repo) => (
            <Card
              key={repo.repo_id}
              size="small"
              title={
                <Space>
                  <FolderOutlined />
                  <Typography.Text strong>{repo.name}</Typography.Text>
                  <Tag color="blue" style={{ marginLeft: 8 }}>
                    Managed
                  </Tag>
                </Space>
              }
              extra={
                <Space>
                  <Button
                    type="text"
                    size="small"
                    icon={<EditOutlined />}
                    onClick={() => handleOpenEditModal(repo)}
                  />
                  <Popconfirm
                    title="Delete repository?"
                    description={
                      <>
                        <p>Are you sure you want to delete "{repo.name}"?</p>
                        <p style={{ color: '#ff4d4f' }}>
                          ⚠️ This will delete the local repository and all associated worktrees.
                        </p>
                      </>
                    }
                    onConfirm={() => handleDeleteRepo(repo.repo_id)}
                    okText="Delete"
                    cancelText="Cancel"
                    okButtonProps={{ danger: true }}
                  >
                    <Button type="text" size="small" icon={<DeleteOutlined />} danger />
                  </Popconfirm>
                </Space>
              }
            >
              {/* Repo metadata */}
              <Space direction="vertical" size={8} style={{ width: '100%' }}>
                <div>
                  <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                    Slug:{' '}
                  </Typography.Text>
                  <Typography.Text code style={{ fontSize: 12 }}>
                    {repo.slug}
                  </Typography.Text>
                </div>

                {repo.remote_url && (
                  <div>
                    <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                      Remote:{' '}
                    </Typography.Text>
                    <Typography.Text code style={{ fontSize: 11 }}>
                      {repo.remote_url}
                    </Typography.Text>
                  </div>
                )}

                {repo.local_path && (
                  <div>
                    <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                      Path:{' '}
                    </Typography.Text>
                    <Typography.Text code style={{ fontSize: 11 }}>
                      {repo.local_path}
                    </Typography.Text>
                  </div>
                )}
              </Space>
            </Card>
          ))}
        </Space>
      )}

      {/* Create/Edit Repository Modal */}
      <Modal
        title={isEditing ? 'Edit Repository' : 'Clone Repository'}
        open={repoModalOpen}
        onOk={handleSaveRepo}
        onCancel={handleCancelModal}
        okText={isEditing ? 'Save' : 'Clone'}
      >
        <Form form={repoForm} layout="vertical" style={{ marginTop: 16 }}>
          {!isEditing && (
            <Form.Item
              label="Repository URL"
              name="url"
              rules={[{ required: !isEditing, message: 'Please enter a git repository URL' }]}
              extra="HTTPS or SSH URL"
            >
              <Input
                placeholder="https://github.com/apache/superset.git"
                onChange={handleUrlChange}
                autoFocus
              />
            </Form.Item>
          )}

          <Form.Item
            label="Repository Slug"
            name="slug"
            rules={[
              { required: true, message: 'Please enter a slug' },
              {
                pattern: /^[a-zA-Z0-9_-]+\/[a-zA-Z0-9_-]+$/,
                message: 'Slug must be in org/repo format (e.g., apache/superset)',
              },
            ]}
            extra="Auto-detected from URL (editable). Format: org/repo"
          >
            <Input placeholder="apache/superset" disabled={isEditing} />
          </Form.Item>

          <Form.Item
            label="Default Branch"
            name="default_branch"
            initialValue="main"
            rules={[{ required: true, message: 'Please enter the default branch' }]}
            extra="The main branch to base new worktrees on (e.g., 'main', 'master', 'develop')"
          >
            <Input placeholder="main" />
          </Form.Item>
        </Form>
      </Modal>
    </div>
  );
};
