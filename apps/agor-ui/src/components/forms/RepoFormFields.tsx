import { extractSlugFromUrl } from '@agor-live/client';
import type { FormInstance, RadioChangeEvent } from 'antd';
import { Form, Input, Radio, Typography } from 'antd';
import { extractSlugFromPath } from '@/utils/repoSlug';

export interface RepoFormFieldsProps {
  form: FormInstance;
  mode: 'create' | 'edit';
  repoMode: 'remote' | 'local';
  onRepoModeChange: (e: RadioChangeEvent) => void;
}

/**
 * Shared repo form fields used in both the CreateDialog RepoTab
 * and the SettingsModal ReposTable create/edit modal.
 *
 * Renders: Repository Type radio, URL/Path input, Slug, Default Branch.
 * Does NOT render a <Form> wrapper — the parent owns the form instance.
 */
export const RepoFormFields: React.FC<RepoFormFieldsProps> = ({
  form,
  mode,
  repoMode,
  onRepoModeChange,
}) => {
  const isEditing = mode === 'edit';
  const isLocal = repoMode === 'local';

  const handleUrlChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const url = e.target.value;
    if (!url) return;
    try {
      const slug = extractSlugFromUrl(url);
      if (slug) form.setFieldsValue({ slug });
    } catch {
      // Partial/invalid URL while typing — leave slug untouched.
    }
  };

  const handlePathChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const path = e.target.value;
    if (path) {
      const slug = extractSlugFromPath(path);
      if (slug) form.setFieldsValue({ slug });
    }
  };

  return (
    <>
      <Form.Item label="Repository Type">
        <Radio.Group
          value={repoMode}
          onChange={onRepoModeChange}
          disabled={isEditing}
          buttonStyle="solid"
        >
          <Radio.Button value="remote">Remote (clone)</Radio.Button>
          <Radio.Button value="local">Local (existing)</Radio.Button>
        </Radio.Group>
      </Form.Item>

      {!isEditing && !isLocal && (
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

      {!isEditing && isLocal && (
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
          { required: !isLocal || isEditing, message: 'Please enter a slug' },
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
        <Input placeholder="apache/superset" disabled={isEditing} />
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

      {!isEditing && (
        <Typography.Text type="secondary" style={{ fontSize: 12 }}>
          {isLocal
            ? 'Link an existing git clone on this machine.'
            : 'The repository will be cloned to the server.'}
        </Typography.Text>
      )}
    </>
  );
};
