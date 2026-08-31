import type { Board, Branch, MCPServer } from '@agor-live/client';
import { getTeammateConfig } from '@agor-live/client';
import { RobotOutlined } from '@ant-design/icons';
import { Descriptions, Form, Input, Select, Space, Typography } from 'antd';
import { useAgorStore } from '../../../store/agorStore';
import { selectBranchById } from '../../../store/selectors';
import { boardSelectOptions } from '../../BoardTile';
import { EmojiPickerInput } from '../../EmojiPickerInput/EmojiPickerInput';
import { MCPServerSelect } from '../../MCPServerSelect';
import { FIELD_WIDTHS } from '../../SettingsModal/panelPrimitives';
import { Tag } from '../../Tag';
import type { GeneralFormState, TeammateFormState } from '../useBranchModalForm';

interface TeammateTabProps {
  branch: Branch;
  canEdit: boolean;
  state: TeammateFormState;
  setField: <K extends keyof TeammateFormState>(key: K, value: TeammateFormState[K]) => void;
  // Board + default MCP servers are folded in here from the General tab, which
  // teammates no longer show. Git-mechanics fields (Issue / PR URL) are dropped
  // for teammates — they don't apply to a persistent AI companion.
  boards: Board[];
  mcpServers: MCPServer[];
  general: GeneralFormState;
  setGeneral: <K extends keyof GeneralFormState>(key: K, value: GeneralFormState[K]) => void;
}

export const TeammateTab: React.FC<TeammateTabProps> = ({
  branch,
  canEdit,
  state,
  setField,
  boards,
  mcpServers,
  general,
  setGeneral,
}) => {
  const branchById = useAgorStore(selectBranchById);
  const config = getTeammateConfig(branch);
  if (!config) return null;

  return (
    <div style={{ width: '100%', maxHeight: '70vh', overflowY: 'auto' }}>
      <Space orientation="vertical" size="large" style={{ width: '100%' }}>
        <Space>
          {config.emoji ? (
            <span style={{ fontSize: 20 }}>{config.emoji}</span>
          ) : (
            <RobotOutlined style={{ fontSize: 20 }} />
          )}
          <Typography.Text strong style={{ fontSize: 16 }}>
            Teammate Configuration
          </Typography.Text>
        </Space>

        {/* Editable fields */}
        <Form layout="vertical" colon={false}>
          <Form.Item label="Display Name" style={FIELD_WIDTHS.short}>
            <Input
              value={state.displayName}
              onChange={(e) => setField('displayName', e.target.value)}
              placeholder="Teammate display name"
              disabled={!canEdit}
            />
          </Form.Item>
          <Form.Item label="Icon">
            <EmojiPickerInput
              value={state.emoji}
              onChange={(val) => setField('emoji', val)}
              defaultEmoji="🤖"
              disabled={!canEdit}
            />
          </Form.Item>
          <Form.Item
            label="Description"
            tooltip="What does this AI teammate do? Visible to other agents via MCP."
          >
            <Input.TextArea
              value={state.description}
              onChange={(e) => setField('description', e.target.value)}
              placeholder="What does this AI teammate do?"
              rows={2}
              disabled={!canEdit}
            />
          </Form.Item>

          <Form.Item label="Board" style={FIELD_WIDTHS.short}>
            <Select
              value={general.boardId}
              onChange={(value) => setGeneral('boardId', value)}
              placeholder="Select board (optional)..."
              allowClear
              disabled={!canEdit}
              options={boardSelectOptions(boards, branchById)}
            />
          </Form.Item>
          <Form.Item
            label="MCP Servers"
            tooltip="Default MCP servers for new sessions with this teammate"
            style={FIELD_WIDTHS.medium}
          >
            <MCPServerSelect
              mcpServers={mcpServers}
              value={general.mcpServerIds}
              onChange={(value) => setGeneral('mcpServerIds', value)}
              placeholder="Select default MCP servers..."
              disabled={!canEdit}
            />
          </Form.Item>
        </Form>

        {/* Read-only metadata */}
        <Descriptions column={1} bordered size="small">
          {config.frameworkRepo && (
            <Descriptions.Item label="Framework Repo">
              <Typography.Text code>{config.frameworkRepo}</Typography.Text>
            </Descriptions.Item>
          )}
          {config.frameworkVersion && (
            <Descriptions.Item label="Framework Version">
              <Typography.Text code>{config.frameworkVersion}</Typography.Text>
            </Descriptions.Item>
          )}
          <Descriptions.Item label="Created via">
            {config.createdViaOnboarding ? (
              <Tag color="blue">Onboarding Wizard</Tag>
            ) : (
              <Tag>Manual</Tag>
            )}
          </Descriptions.Item>
          {/* Preserved here since teammates no longer show the General tab. */}
          <Descriptions.Item label="Created">
            {new Date(branch.created_at).toLocaleString()}
          </Descriptions.Item>
        </Descriptions>
      </Space>
    </div>
  );
};
