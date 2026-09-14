import {
  BRANCH_CLEANUP_COMMAND_MAX_LENGTH,
  DEFAULT_BRANCH_CLEANUP_COMMAND,
  DEFAULT_REPO_CLEANUP_POLICY,
} from '@agor-live/client';
import { DownOutlined } from '@ant-design/icons';
import { Alert, Checkbox, Collapse, Form, Input, Space, Typography } from 'antd';
import { type ComponentProps, useCallback, useEffect, useState } from 'react';
import { BranchCleanupWarning } from '../BranchCleanupWarning';

function CleanupCommandInput({
  onInvalid,
  ...props
}: ComponentProps<typeof Input.TextArea> & { onInvalid: () => void }) {
  const { errors } = Form.Item.useStatus();
  useEffect(() => {
    if (errors.length) onInvalid();
  }, [errors.length, onInvalid]);
  return <Input.TextArea {...props} />;
}

/** Shared executable-configuration editor. The enclosing form owns saving and authority. */
export function RepoCleanupPolicyFields() {
  const [expanded, setExpanded] = useState(false);
  const revealError = useCallback(() => setExpanded(true), []);
  const form = Form.useFormInstance();
  const protectionAllowed = Form.useWatch(['cleanup_policy', 'allow_branch_protection'], form);
  return (
    <Collapse
      ghost
      expandIcon={({ isActive }) => <DownOutlined rotate={isActive ? 180 : 0} />}
      activeKey={expanded ? ['cleanup'] : []}
      onChange={(keys) => setExpanded(keys.includes('cleanup'))}
      destroyOnHidden={false}
      items={[
        {
          key: 'cleanup',
          label: <Typography.Text strong>Branch cleanup</Typography.Text>,
          // Register fields even before first expansion: validateFields must see
          // the full policy on every Save, including a never-opened section.
          forceRender: true,
          children: (
            <>
              <Space orientation="vertical" style={{ width: '100%' }}>
                <BranchCleanupWarning />
                {protectionAllowed === false && (
                  <Alert
                    type="warning"
                    showIcon
                    description="Saved protection is overridden: previously protected branches become eligible when cleanup is enabled. Reallowing protection restores their preferences."
                  />
                )}
              </Space>
              <Form.Item
                name={['cleanup_policy', 'enabled']}
                valuePropName="checked"
                initialValue={DEFAULT_REPO_CLEANUP_POLICY.enabled}
              >
                <Checkbox>Enable branch cleanup</Checkbox>
              </Form.Item>
              <Form.Item
                label="Cleanup command"
                name={['cleanup_policy', 'command']}
                initialValue={DEFAULT_BRANCH_CLEANUP_COMMAND}
                dependencies={[['cleanup_policy', 'enabled']]}
                rules={[
                  { max: BRANCH_CLEANUP_COMMAND_MAX_LENGTH },
                  ({ getFieldValue }) => ({
                    validator: (_, value) =>
                      typeof value === 'string' &&
                      !value.includes('\0') &&
                      (!getFieldValue(['cleanup_policy', 'enabled']) || value.trim())
                        ? Promise.resolve()
                        : Promise.reject(
                            new Error(
                              'Enter a command before enabling cleanup (no NUL characters).'
                            )
                          ),
                  }),
                ]}
                extra="Only git clean -fdX can currently execute. Custom commands are saved but blocked until descendant containment is supported. Do not include secrets."
              >
                <CleanupCommandInput
                  onInvalid={revealError}
                  autoSize={{ minRows: 2, maxRows: 6 }}
                  maxLength={BRANCH_CLEANUP_COMMAND_MAX_LENGTH}
                />
              </Form.Item>
              <Form.Item
                name={['cleanup_policy', 'allow_branch_protection']}
                valuePropName="checked"
                initialValue={DEFAULT_REPO_CLEANUP_POLICY.allow_branch_protection}
              >
                <Checkbox>Allow branch protection</Checkbox>
              </Form.Item>
            </>
          ),
        },
      ]}
    />
  );
}
