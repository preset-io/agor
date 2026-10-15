import type { AgorClient, Branch } from '@agor-live/client';
import { Form, Radio } from 'antd';
import { useState } from 'react';
import { teammateLabel } from '@/utils/teammateLabels';
import { BranchSelect } from './BranchSelect';
import { GatewayNameInput } from './GatewayNameInput';

/** Creation-only presentation. Both modes still submit a target_branch_id. */
export function GatewayTargetFields({
  client,
  channelTypeLabel,
}: {
  client: AgorClient | null;
  channelTypeLabel: string;
}) {
  const form = Form.useFormInstance();
  const targetKind = Form.useWatch('target_kind', form) ?? 'teammate';
  const teammatesOnly = targetKind === 'teammate';
  const targetId = Form.useWatch('target_branch_id', form);
  const [selectedBranch, setSelectedBranch] = useState<Branch>();
  const targetName =
    selectedBranch && selectedBranch.branch_id === targetId
      ? teammatesOnly
        ? teammateLabel(selectedBranch)
        : selectedBranch.name || selectedBranch.ref || selectedBranch.branch_id
      : undefined;

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
        name="target_branch_id"
        rules={[
          {
            required: true,
            message: teammatesOnly
              ? 'Please select an AI Teammate'
              : 'Please select a target branch',
          },
        ]}
      >
        <BranchSelect
          key={targetKind}
          aria-label={teammatesOnly ? 'AI Teammate' : 'Target Branch'}
          client={client}
          teammatesOnly={teammatesOnly}
          onChange={(_id, branch) => setSelectedBranch(branch)}
          emptyText={
            teammatesOnly
              ? 'No AI Teammates available. Create a teammate first, or choose Specific branch.'
              : undefined
          }
          placeholder={teammatesOnly ? 'Select an AI Teammate' : 'Select a branch'}
        />
      </Form.Item>
      <Form.Item
        label="Channel name"
        required={false}
        name="name"
        hidden={!targetId}
        rules={
          targetId
            ? [{ required: true, whitespace: true, message: 'Please enter a channel name' }]
            : []
        }
      >
        <GatewayNameInput
          targetName={targetName}
          channelTypeLabel={channelTypeLabel}
          onSuggest={(name) => form.setFieldValue('name', name)}
        />
      </Form.Item>
    </>
  );
}
