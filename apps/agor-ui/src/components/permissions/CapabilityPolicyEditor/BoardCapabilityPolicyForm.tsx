import type {
  BoardCapabilityPoliciesDraft,
  CapabilityPolicyPrincipalDescriptor,
  UserID,
} from '@agor/core/types';
import { BranchesOutlined, LayoutOutlined } from '@ant-design/icons';
import { Alert, Divider, Flex, Tabs, Typography, theme } from 'antd';
import { CapabilityPolicyEditor } from './CapabilityPolicyEditor';
import { ImmutablePrimaryOwner } from './ImmutablePrimaryOwner';
import { BOARD_ACCESS_EDITOR_CONTEXT, BRANCH_ACCESS_EDITOR_CONTEXT } from './policyEditorModel';
import type { PrototypeAccessSubject } from './prototypeEffectiveAccess';

interface BoardCapabilityPolicyFormProps {
  value: BoardCapabilityPoliciesDraft;
  onChange: (value: BoardCapabilityPoliciesDraft) => void;
  principals: CapabilityPolicyPrincipalDescriptor[];
  subjects: PrototypeAccessSubject[];
  sampleBranchOwnerUserId: UserID;
}

function findUserDescriptor(
  principals: CapabilityPolicyPrincipalDescriptor[],
  userId: UserID
): CapabilityPolicyPrincipalDescriptor | undefined {
  return principals.find(
    (principal) =>
      principal.principal.principal_type === 'user' && principal.principal.user_id === userId
  );
}

export const BoardCapabilityPolicyForm: React.FC<BoardCapabilityPolicyFormProps> = ({
  value,
  onChange,
  principals,
  subjects,
  sampleBranchOwnerUserId,
}) => {
  const { token } = theme.useToken();
  const owner = findUserDescriptor(principals, value.primary_owner_user_id);

  return (
    <Flex vertical gap={token.paddingMD}>
      <div>
        <Typography.Title level={4} style={{ marginBottom: token.paddingXXS }}>
          Board permissions
        </Typography.Title>
      </div>
      <ImmutablePrimaryOwner owner={owner} resourceLabel="board" />
      <Divider style={{ marginBlock: 0 }} />
      <Tabs
        defaultActiveKey="board-access"
        size="small"
        items={[
          {
            key: 'board-access',
            label: (
              <span>
                <LayoutOutlined /> Board access
              </span>
            ),
            children: (
              <CapabilityPolicyEditor
                title="Who can see and manage this board"
                description="Board access does not grant branch access."
                value={value.board_access}
                onChange={(boardAccess) => onChange({ ...value, board_access: boardAccess })}
                context={BOARD_ACCESS_EDITOR_CONTEXT}
                primaryOwnerUserId={value.primary_owner_user_id}
                principals={principals}
                subjects={subjects}
              />
            ),
          },
          {
            key: 'branch-template',
            label: (
              <span>
                <BranchesOutlined /> Branch defaults
              </span>
            ),
            children: (
              <Flex vertical gap={token.paddingMD}>
                <Alert
                  type="info"
                  showIcon
                  description="Inherited branches use these defaults. Board access and personal session sharing remain separate."
                />
                <CapabilityPolicyEditor
                  title="Defaults inherited by this board’s branches"
                  value={value.branch_template}
                  onChange={(branchTemplate) =>
                    onChange({ ...value, branch_template: branchTemplate })
                  }
                  context={BRANCH_ACCESS_EDITOR_CONTEXT}
                  primaryOwnerUserId={sampleBranchOwnerUserId}
                  principals={principals}
                  subjects={subjects}
                />
              </Flex>
            ),
          },
        ]}
      />
    </Flex>
  );
};
