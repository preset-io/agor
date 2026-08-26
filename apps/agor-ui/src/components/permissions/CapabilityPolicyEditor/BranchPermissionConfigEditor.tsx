import type {
  BranchPermissionConfigDraft,
  CapabilityPolicyPrincipalDescriptor,
  UserID,
} from '@agor/core/types';
import { Divider, Flex, theme } from 'antd';
import { CapabilityPolicyEditor } from './CapabilityPolicyEditor';
import type { EffectiveAccessSubject } from './effectiveAccessPreviewModel';
import { PersonalSessionSharingSection } from './PersonalSessionSharingSection';
import { BRANCH_ACCESS_EDITOR_CONTEXT } from './policyEditorModel';

interface BranchPermissionConfigEditorProps {
  value: BranchPermissionConfigDraft;
  onChange: (value: BranchPermissionConfigDraft) => void;
  accessTitle: string;
  accessDescription?: React.ReactNode;
  primaryOwnerUserId: UserID;
  currentUserId: UserID;
  principals: CapabilityPolicyPrincipalDescriptor[];
  subjects: EffectiveAccessSubject[];
  readOnly?: boolean;
  accessReadOnly?: boolean;
  sharingReadOnly?: boolean;
  showModeSelector?: boolean;
  sharingScope: 'board_defaults' | 'branch';
  personalSessionSharingWorkspaceEnabled?: boolean;
}

/**
 * The one editor for the complete config stored by board templates and branch
 * overrides. Server-side commands must still authorize access-policy edits and
 * each owner's personal sharing rule independently.
 */
export const BranchPermissionConfigEditor: React.FC<BranchPermissionConfigEditorProps> = ({
  value,
  onChange,
  accessTitle,
  accessDescription,
  primaryOwnerUserId,
  currentUserId,
  principals,
  subjects,
  readOnly,
  accessReadOnly,
  sharingReadOnly,
  showModeSelector = true,
  sharingScope,
  personalSessionSharingWorkspaceEnabled = true,
}) => {
  const { token } = theme.useToken();

  return (
    <Flex vertical gap={token.paddingMD}>
      <CapabilityPolicyEditor
        title={accessTitle}
        description={accessDescription}
        value={value.access}
        onChange={(access) => onChange({ ...value, access })}
        readOnly={accessReadOnly ?? readOnly}
        showModeSelector={showModeSelector}
        context={BRANCH_ACCESS_EDITOR_CONTEXT}
        primaryOwnerUserId={primaryOwnerUserId}
        principals={principals}
        subjects={subjects}
      />
      <Divider style={{ marginBlock: 0 }} />
      <PersonalSessionSharingSection
        value={value.session_sharing}
        onChange={(sessionSharing) => onChange({ ...value, session_sharing: sessionSharing })}
        currentUserId={currentUserId}
        principals={principals}
        workspaceEnabled={personalSessionSharingWorkspaceEnabled}
        readOnly={sharingReadOnly ?? readOnly}
        scope={sharingScope}
      />
    </Flex>
  );
};
