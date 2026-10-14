import type { AgorClient } from '@agor-live/client';
import { Form, Radio } from 'antd';
import { BranchSelect } from './BranchSelect';

/** Creation-only presentation. Both modes still submit a target_branch_id. */
export function GatewayTargetFields({ client }: { client: AgorClient | null }) {
  const form = Form.useFormInstance();
  const targetKind = Form.useWatch('target_kind', form) ?? 'teammate';
  const teammatesOnly = targetKind === 'teammate';

  return (
    <>
      <Form.Item label="Route messages to" name="target_kind" initialValue="teammate">
        <Radio.Group
          name="gateway-target-kind"
          aria-label="Route messages to"
          onChange={() => {
            // Never silently carry a branch into the other mode. setFieldValue
            // also clears validation errors belonging to the previous choice.
            form.setFieldValue('target_branch_id', undefined);
          }}
          options={[
            { value: 'teammate', label: 'AI Teammate' },
            { value: 'branch', label: 'Specific branch' },
          ]}
        />
      </Form.Item>
      <Form.Item
        label={teammatesOnly ? 'AI Teammate' : 'Target Branch'}
        name="target_branch_id"
        rules={[
          {
            required: true,
            message: teammatesOnly
              ? 'Please select an AI Teammate'
              : 'Please select a target branch',
          },
        ]}
        extra={
          teammatesOnly
            ? "Recommended: work with an AI Teammate through this channel. New sessions use the teammate's branch."
            : 'Use a specific branch for a custom workflow or a long-lived branch without a teammate.'
        }
      >
        <BranchSelect
          key={targetKind}
          client={client}
          teammatesOnly={teammatesOnly}
          emptyText={
            teammatesOnly
              ? 'No AI Teammates available. Create a teammate first, or choose Specific branch.'
              : undefined
          }
          placeholder={teammatesOnly ? 'Select an AI Teammate' : 'Select a branch'}
        />
      </Form.Item>
    </>
  );
}
