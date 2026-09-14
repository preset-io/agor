import type { AgorClient, Repo, User } from '@agor-live/client';
import { hasMinimumRole, ROLES, resolveRepoCleanupPolicy } from '@agor-live/client';
import { Alert, Form, Modal } from 'antd';
import { useLayoutEffect, useState } from 'react';
import {
  useAuthenticatedAuthorityScope,
  useAuthorityOperationGuard,
} from '@/hooks/useAuthorityOperationGuard';
import { RepoCleanupPolicyFields } from '../forms/RepoCleanupPolicyFields';

/** An independent draft above the archive modal; saving never submits the parent. */
export function RepoCleanupSettingsModal({
  client,
  user,
  repo,
  open,
  onCancel,
  onSaved,
}: {
  client: AgorClient;
  user: User;
  repo: Repo;
  open: boolean;
  onCancel: () => void;
  onSaved: () => void;
}) {
  const [form] = Form.useForm();
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string>();
  const scope = useAuthenticatedAuthorityScope(client, `${user.user_id}:${user.role}`);
  const guard = useAuthorityOperationGuard(scope.operationScope);
  const canSave = hasMinimumRole(user.role, ROLES.ADMIN) && guard.isCurrent();
  // A same-caller reconnect preserves the draft; a caller or target change erases it.
  // biome-ignore lint/correctness/useExhaustiveDependencies: reset by identity/target/open, not live repository events
  useLayoutEffect(() => {
    if (open)
      form.setFieldsValue({ cleanup_policy: resolveRepoCleanupPolicy(repo.cleanup_policy) });
    setSaving(false);
    setError(undefined);
  }, [open, repo.repo_id, scope.identityKey, form]);
  // Preserve the reconnect draft, but release the obsolete operation's spinner.
  // biome-ignore lint/correctness/useExhaustiveDependencies: guard identity denotes the authority epoch
  useLayoutEffect(() => {
    setSaving(false);
  }, [guard]);
  const save = async () => {
    if (!canSave) return;
    const operation = guard.begin();
    try {
      const values = await form.validateFields();
      if (!operation.isCurrent()) return;
      setSaving(true);
      await client.service('repos').patch(repo.repo_id, { cleanup_policy: values.cleanup_policy });
      if (operation.isCurrent()) onSaved();
    } catch {
      if (operation.isCurrent())
        setError(
          'Repository settings were not saved. Check the command and your configuration access, then retry.'
        );
    } finally {
      if (operation.isCurrent()) setSaving(false);
    }
  };
  return (
    <Modal
      title={`Repository settings — ${repo.name}`}
      open={open}
      onOk={save}
      onCancel={onCancel}
      okText="Save settings"
      confirmLoading={saving}
      okButtonProps={{ disabled: !canSave }}
      destroyOnHidden
    >
      <Form form={form} layout="vertical" disabled={!canSave || saving}>
        <RepoCleanupPolicyFields />
        {error && <Alert type="error" showIcon title={error} />}
      </Form>
    </Modal>
  );
}
