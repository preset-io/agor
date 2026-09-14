import type {
  BranchPermissionConfigDraft,
  CapabilityPolicyPrincipalDescriptor,
  UserID,
} from '@agor/core/types';
import { Divider, Flex, theme } from 'antd';
import { CapabilityPolicyEditor } from './CapabilityPolicyEditor';
import type { EffectiveAccessSubject } from './effectiveAccessPreviewModel';
import { BRANCH_ACCESS_EDITOR_CONTEXT } from './policyEditorModel';
import { SharedSessionPromptingSection } from './SharedSessionPromptingSection';

interface BranchPermissionConfigEditorProps {
  value: BranchPermissionConfigDraft;
  onChange: (value: BranchPermissionConfigDraft) => void;
  accessTitle: string;
  accessDescription?: React.ReactNode;
  primaryOwnerUserId: UserID;
  principals: CapabilityPolicyPrincipalDescriptor[];
  subjects: EffectiveAccessSubject[];
  readOnly?: boolean;
  accessReadOnly?: boolean;
  sharingReadOnly?: boolean;
  showModeSelector?: boolean;
  sharingScope: 'board_defaults' | 'branch';
  sessionSharingWorkspaceEnabled?: boolean;
}

/**
 * The one editor for the complete config stored by board templates and branch
 * overrides. The workspace preference remains an independent, admin-owned
 * fail-closed gate over the branch-level switch.
 */
export const BranchPermissionConfigEditor: React.FC<BranchPermissionConfigEditorProps> = ({
  value,
  onChange,
  accessTitle,
  accessDescription,
  primaryOwnerUserId,
  principals,
  subjects,
  readOnly,
  accessReadOnly,
  sharingReadOnly,
  showModeSelector = true,
  sharingScope,
  sessionSharingWorkspaceEnabled = true,
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
      <SharedSessionPromptingSection
        value={value.allow_shared_session_prompts}
        onChange={(allowSharedSessionPrompts) =>
          onChange({ ...value, allow_shared_session_prompts: allowSharedSessionPrompts })
        }
        workspaceEnabled={sessionSharingWorkspaceEnabled}
        readOnly={sharingReadOnly ?? readOnly}
        scope={sharingScope}
      />
    </Flex>
  );
};
