import type {
  AgorClient,
  BranchCapabilityPolicy,
  CapabilityPolicyWorkspacePreferences,
  Group,
  Session,
  User,
} from '@agor-live/client';
import { Alert, Skeleton } from 'antd';
import { BranchCapabilityPolicyModalEditor } from '../../permissions/CapabilityPolicyEditor';

interface PermissionsTabProps {
  loading: boolean;
  canManageAccess: boolean;
  allGroups: Group[];
  currentUser?: User | null;
  client: AgorClient | null;
  error?: Error | null;
  sessions?: Session[];
  permissionUsers?: User[];
  capabilityPolicy?: BranchCapabilityPolicy | null;
  onCapabilityPolicyChange?: (value: BranchCapabilityPolicy) => void;
  workspacePreferences?: CapabilityPolicyWorkspacePreferences;
}

export const PermissionsTab: React.FC<PermissionsTabProps> = ({
  loading,
  canManageAccess,
  allGroups,
  currentUser,
  client,
  error,
  sessions = [],
  permissionUsers = [],
  capabilityPolicy,
  onCapabilityPolicyChange,
  workspacePreferences = { session_sharing_enabled: false },
}) => {
  if (error) {
    return <Alert type="error" showIcon description={error.message} />;
  }
  if (loading || !capabilityPolicy || !onCapabilityPolicyChange) {
    return <Skeleton active paragraph={{ rows: 6 }} />;
  }
  return (
    <div style={{ width: '100%', maxHeight: '70vh', overflowY: 'auto' }}>
      <BranchCapabilityPolicyModalEditor
        value={capabilityPolicy}
        onChange={onCapabilityPolicyChange}
        client={client}
        currentUser={currentUser}
        users={permissionUsers}
        groups={allGroups}
        sessions={sessions}
        workspacePreferences={workspacePreferences}
        canManageAccess={canManageAccess}
      />
    </div>
  );
};
