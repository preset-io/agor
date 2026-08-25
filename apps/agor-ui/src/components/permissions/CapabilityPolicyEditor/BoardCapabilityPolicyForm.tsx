import type {
  BoardCapabilityPoliciesDraft,
  CapabilityPolicyPrincipalDescriptor,
  UserID,
} from '@agor/core/types';
import { BranchesOutlined, LayoutOutlined } from '@ant-design/icons';
import { Alert, Flex, Tabs, Typography, theme } from 'antd';
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
    <Flex vertical gap={token.paddingLG}>
      <div>
        <Typography.Title level={3} style={{ marginBottom: token.paddingXXS }}>
          Board permissions
        </Typography.Title>
        <Typography.Text type="secondary">
          Two separate policies control the board surface and the live defaults its branches may
          inherit.
        </Typography.Text>
      </div>
      <ImmutablePrimaryOwner owner={owner} resourceLabel="board" />
      <Tabs
        defaultActiveKey="board-access"
        items={[
          {
            key: 'board-access',
            label: (
              <span>
                <LayoutOutlined /> 1. Board access
              </span>
            ),
            children: (
              <CapabilityPolicyEditor
                title="Who can see and manage this board"
                description="Controls the board canvas, layout, zones, and permission settings. It does not grant access to a branch just because its card appears here."
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
                <BranchesOutlined /> 2. Live branch defaults
              </span>
            ),
            children: (
              <Flex vertical gap={token.paddingLG}>
                <Alert
                  type="info"
                  showIcon
                  title="A live template, not board access"
                  description="Branches bound to Inherit use the current template. Each branch keeps its own immutable primary owner; changing this template neither transfers ownership nor grants board members access to every branch."
                />
                <CapabilityPolicyEditor
                  title="Defaults inherited by this board’s branches"
                  description="Controls branch, session, environment, and filesystem capabilities for branches that remain bound to Inherit. Overridden branches keep their explicit policy."
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
