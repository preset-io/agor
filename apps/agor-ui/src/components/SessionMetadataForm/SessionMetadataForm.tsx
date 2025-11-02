/**
 * Session Metadata Form
 *
 * Reusable form section for session metadata fields:
 * - Title
 *
 * Used in both NewSessionModal and SessionSettingsModal
 *
 * Note: Custom Context (JSON) has been moved to AdvancedSettingsForm.
 * Issue URL and Pull Request URL have been moved to the Worktree entity.
 * These are now managed in the WorktreeModal instead.
 */

import { Form, Input } from 'antd';

export interface SessionMetadataFormProps {
  /** Whether to show help text under each field */
  showHelpText?: boolean;
  /** Whether to show the title field as required */
  titleRequired?: boolean;
  /** Custom label for title field (e.g., "Session Title" vs "Title") */
  titleLabel?: string;
}

/**
 * Form fields for session metadata
 *
 * Expects to be used within a Form context with these field names:
 * - title
 */
export const SessionMetadataForm: React.FC<SessionMetadataFormProps> = ({
  showHelpText = true,
  titleRequired = false,
  titleLabel = 'Session Title',
}) => {
  return (
    <>
      <Form.Item
        name="title"
        label={titleLabel}
        rules={[{ required: titleRequired, message: 'Please enter a session title' }]}
        help={
          showHelpText && !titleRequired ? 'A short descriptive name for this session' : undefined
        }
      >
        <Input placeholder="e.g., Auth System Implementation" />
      </Form.Item>
    </>
  );
};
