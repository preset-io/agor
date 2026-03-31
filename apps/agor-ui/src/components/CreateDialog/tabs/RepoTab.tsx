import type { RadioChangeEvent } from 'antd';
import { Form, Input, Radio, Typography } from 'antd';
import { useCallback, useState } from 'react';

function extractSlugFromUrl(url: string): string {
  try {
    const cleanUrl = url.endsWith('.git') ? url.slice(0, -4) : url;
    if (cleanUrl.includes('@')) {
      const match = cleanUrl.match(/:([^/]+\/[^/]+)$/);
      if (match) return match[1];
    }
    const match = cleanUrl.match(/[:/]([^/]+\/[^/]+)$/);
    if (match) return match[1];
    const segments = cleanUrl.split('/').filter(Boolean);
    if (segments.length >= 2) {
      return `${segments[segments.length - 2]}/${segments[segments.length - 1]}`;
    }
    return '';
  } catch {
    return '';
  }
}

function extractSlugFromPath(path: string): string {
  if (!path) return '';
  const normalized = path.replace(/\\/g, '/');
  const segments = normalized.split('/').filter(Boolean);
  const lastSegment = segments[segments.length - 1] || '';
  if (!lastSegment) return '';
  const sanitized = lastSegment
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '');
  if (!sanitized) return '';
  return `local/${sanitized}`;
}

export interface RepoTabResult {
  mode: 'remote' | 'local';
  remote?: { url: string; slug: string; default_branch: string };
  local?: { path: string; slug?: string };
}

export interface RepoTabProps {
  onValidityChange: (valid: boolean) => void;
  formRef: React.MutableRefObject<(() => Promise<RepoTabResult | null>) | null>;
}

export const RepoTab: React.FC<RepoTabProps> = ({ onValidityChange, formRef }) => {
  const [form] = Form.useForm();
  const [repoMode, setRepoMode] = useState<'remote' | 'local'>('remote');
  const isLocal = repoMode === 'local';

  const handleValuesChange = useCallback(() => {
    setTimeout(() => {
      const values = form.getFieldsValue();
      if (repoMode === 'local') {
        onValidityChange(!!values.path?.trim());
      } else {
        onValidityChange(!!(values.url?.trim() && values.slug?.trim()));
      }
    }, 0);
  }, [form, onValidityChange, repoMode]);

  const handleUrlChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const url = e.target.value;
    if (url) {
      const slug = extractSlugFromUrl(url);
      if (slug) form.setFieldsValue({ slug });
    }
  };

  const handlePathChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const path = e.target.value;
    if (path) {
      const slug = extractSlugFromPath(path);
      if (slug) form.setFieldsValue({ slug });
    }
  };

  const handleModeChange = (e: RadioChangeEvent) => {
    const value = e.target.value as 'remote' | 'local';
    setRepoMode(value);
    form.resetFields();
    form.setFieldsValue({
      default_branch: value === 'remote' ? 'main' : undefined,
    });
    onValidityChange(false);
  };

  formRef.current = async () => {
    try {
      const values = await form.validateFields();
      if (repoMode === 'local') {
        return {
          mode: 'local',
          local: { path: values.path, slug: values.slug || undefined },
        };
      }
      return {
        mode: 'remote',
        remote: {
          url: values.url,
          slug: values.slug,
          default_branch: values.default_branch || 'main',
        },
      };
    } catch {
      return null;
    }
  };

  return (
    <Form
      form={form}
      layout="vertical"
      onValuesChange={handleValuesChange}
      initialValues={{ default_branch: 'main' }}
    >
      <Form.Item label="Repository Type">
        <Radio.Group value={repoMode} onChange={handleModeChange} buttonStyle="solid">
          <Radio.Button value="remote">Remote (clone)</Radio.Button>
          <Radio.Button value="local">Local (existing)</Radio.Button>
        </Radio.Group>
      </Form.Item>

      {!isLocal && (
        <Form.Item
          label="Repository URL"
          name="url"
          rules={[
            { required: true, message: 'Please enter a git repository URL' },
            {
              pattern:
                /^((ssh:\/\/)?git@[\w.-]+(:\d+)?[:/][\w./-]+|https?:\/\/[\w.-]+(:\d+)?\/[\w./-]+)$/,
              message: 'Please enter a valid git URL',
            },
          ]}
          extra="HTTPS or SSH URL (e.g., git@github.com:org/repo.git)"
        >
          <Input
            placeholder="https://github.com/apache/superset.git"
            onChange={handleUrlChange}
            autoFocus
          />
        </Form.Item>
      )}

      {isLocal && (
        <Form.Item
          label="Local Repository Path"
          name="path"
          rules={[{ required: true, message: 'Please enter an absolute path' }]}
          extra="Absolute path on this machine (supports ~/ expansion)"
        >
          <Input placeholder="~/code/my-app" onChange={handlePathChange} autoFocus />
        </Form.Item>
      )}

      <Form.Item
        label="Repository Slug"
        name="slug"
        rules={[
          { required: !isLocal, message: 'Please enter a slug' },
          {
            pattern: /^[a-zA-Z0-9._-]+\/[a-zA-Z0-9._-]+$/,
            message: 'Slug must be in org/repo format',
          },
        ]}
        extra={
          isLocal
            ? 'Provide org/repo format (e.g., local/myapp)'
            : 'Auto-detected from URL (editable)'
        }
      >
        <Input placeholder="apache/superset" />
      </Form.Item>

      {!isLocal && (
        <Form.Item
          label="Default Branch"
          name="default_branch"
          rules={[{ required: true, message: 'Please enter the default branch' }]}
          extra="The main branch to base new worktrees on"
        >
          <Input placeholder="main" />
        </Form.Item>
      )}

      <Typography.Text type="secondary" style={{ fontSize: 12 }}>
        {isLocal
          ? 'Link an existing git clone on this machine.'
          : 'The repository will be cloned to the server.'}
      </Typography.Text>
    </Form>
  );
};
