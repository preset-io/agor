import type {
  BoardCapabilityPoliciesDraft,
  CapabilityPolicyPrincipalDescriptor,
  UserID,
} from '@agor/core/types';
import { BranchesOutlined, LayoutOutlined } from '@ant-design/icons';
import { Divider, Flex, Tabs, Typography, theme } from 'antd';
import { BranchPermissionConfigEditor } from './BranchPermissionConfigEditor';
import { CapabilityPolicyEditor } from './CapabilityPolicyEditor';
import type { EffectiveAccessSubject } from './effectiveAccessPreviewModel';
import { ImmutablePrimaryOwner } from './ImmutablePrimaryOwner';
import { BOARD_ACCESS_EDITOR_CONTEXT } from './policyEditorModel';

interface BoardCapabilityPolicyFormProps {
  value: BoardCapabilityPoliciesDraft;
  onChange: (value: BoardCapabilityPoliciesDraft) => void;
  principals: CapabilityPolicyPrincipalDescriptor[];
  subjects: EffectiveAccessSubject[];
  sampleBranchOwnerUserId: UserID;
  sessionSharingWorkspaceEnabled?: boolean;
  canManageAccess?: boolean;
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
  sessionSharingWorkspaceEnabled = true,
  canManageAccess = true,
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
                readOnly={!canManageAccess}
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
              <BranchPermissionConfigEditor
                accessTitle="Defaults inherited by this board’s branches"
                value={value.branch_template}
                onChange={(branchTemplate) =>
                  onChange({ ...value, branch_template: branchTemplate })
                }
                primaryOwnerUserId={sampleBranchOwnerUserId}
                principals={principals}
                subjects={subjects}
                sharingScope="board_defaults"
                sessionSharingWorkspaceEnabled={sessionSharingWorkspaceEnabled}
                readOnly={!canManageAccess}
              />
            ),
          },
        ]}
      />
    </Flex>
  );
};
