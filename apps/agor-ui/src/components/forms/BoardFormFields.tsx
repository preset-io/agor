import type { Board, Group, User } from '@agor-live/client';
import { LockOutlined } from '@ant-design/icons';
import type { FormInstance } from 'antd';
import { Alert, Form, Input, Space, Tabs, Typography } from 'antd';
import { FormEmojiPickerInput } from '../EmojiPickerInput';
import {
  RbacPermissionFields,
  type RbacPermissionValue,
  type RbacVisibility,
} from '../permissions/RbacPermissionFields';
import { BoardBackgroundEditor } from './BoardBackgroundEditor';

/** A value carrying AntD's ColorPicker `toHexString()` serializer. */
interface HexSerializable {
  toHexString: () => string;
}

function hasToHexString(value: unknown): value is HexSerializable {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as { toHexString?: unknown }).toHexString === 'function'
  );
}

/**
 * Normalize the form's `background_color` to the persisted wire value: a
 * string as-is, an AntD ColorPicker value via `toHexString()`, or `null` when
 * empty (so the backend clears the field rather than dropping `undefined`).
 */
function normalizeBackgroundColor(value: unknown): string | null {
  if (typeof value === 'string') return value.trim() ? value : null;
  if (hasToHexString(value)) return value.toHexString();
  return null;
}

/**
 * Extract board form values from the form instance.
 * Uses getFieldsValue(true) to include values from collapsed/unmounted fields.
 * Sends `null` for cleared fields so the backend actually clears them
 * (undefined is dropped by JSON.stringify and never reaches the server's
 * shallow-merge patch). The `Board` type uses `string | undefined`, but at
 * runtime the boards repository treats `null` as "clear this field", so the
 * cast is honest about wire semantics even though TS can't express them.
 */
export function extractBoardFormValues(
  form: FormInstance,
  options: { includeLegacyPermissions?: boolean } = {}
): Partial<Board> {
  const values = form.getFieldsValue(true);
  const bgColor = values.background_color;
  return {
    name: values.name,
    // Board icons are Unicode emoji strings. Keep the historical default when
    // a new board has not selected one; existing multi-codepoint values pass
    // through unchanged.
    icon: values.icon || '📋',
    description: values.description,
    // background_color is usually a string (gradient/CSS/hex), but the
    // ColorPicker yields an AntD AggregationColor. Only serialize via
    // toHexString when it's actually present; otherwise clear the field.
    background_color: normalizeBackgroundColor(bgColor),
    custom_css: values.custom_css || null,
    ...(options.includeLegacyPermissions === false
      ? {}
      : {
          access_mode: values.access_mode || 'shared',
          default_others_can:
            values.access_mode === 'private' ? 'none' : values.default_others_can || 'session',
          default_others_fs_access: values.default_others_fs_access || 'read',
        }),
    custom_context: values.custom_context ? JSON.parse(values.custom_context) : null,
  } as unknown as Partial<Board>;
}

export interface BoardFormFieldsProps {
  form: FormInstance;
  /** Whether to auto-focus the name input */
  autoFocus?: boolean;
  /** Extra content rendered inside the "Advanced" collapse panel */
  extra?: React.ReactNode;
  /**
   * Per-board identity forwarded to the background editor so it re-syncs its
   * mode from the freshly-loaded form values when the board changes.
   */
  backgroundResetSignal?: string;
  rbacEnabled?: boolean;
  allUsers?: User[];
  allGroups?: Group[];
  /** Normalized permission editor mounted by BoardEditModal and persisted separately. */
  capabilityPolicyEditor?: React.ReactNode;
  /**
   * Whether the caller may edit the board's general settings (name,
   * description, appearance). Defaults to `true` for the legacy/non-RBAC
   * path, where every board mutator has always been allowed to save.
   * `board.edit` is a single capability covering all of these fields
   * together, so they're gated uniformly rather than field-by-field.
   */
  canEditGeneral?: boolean;
}

/**
 * Shared board form fields used in the CreateDialog BoardTab
 * and the SettingsModal BoardsTable create/edit modals.
 *
 * Renders: Name, Description, and CSS / Advanced tabs.
 * Does NOT render a <Form> wrapper — the parent owns the form instance.
 */
export const BoardFormFields: React.FC<BoardFormFieldsProps> = ({
  form,
  autoFocus,
  extra,
  backgroundResetSignal,
  rbacEnabled = false,
  allUsers = [],
  allGroups = [],
  capabilityPolicyEditor,
  canEditGeneral = true,
}) => {
  const generalFields = (
    <>
      <Form.Item
        label="Name"
        required
        style={{ marginBottom: 24 }}
        help={
          canEditGeneral ? undefined : (
            <Typography.Text type="secondary" style={{ fontSize: 12 }}>
              <LockOutlined style={{ marginRight: 4 }} />
              You don't have permission to edit this board.
            </Typography.Text>
          )
        }
      >
        <Space.Compact style={{ display: 'flex' }}>
          <FormEmojiPickerInput fieldName="icon" defaultEmoji="📋" disabled={!canEditGeneral} />
          <Form.Item
            name="name"
            noStyle
            rules={[{ required: true, message: 'Please enter a board name' }]}
          >
            <Input
              placeholder="My Board"
              style={{ flex: 1 }}
              autoFocus={autoFocus}
              disabled={!canEditGeneral}
            />
          </Form.Item>
        </Space.Compact>
      </Form.Item>

      <Form.Item label="Description" name="description">
        <Input.TextArea placeholder="Optional description..." rows={3} disabled={!canEditGeneral} />
      </Form.Item>
    </>
  );

  const watchOptions = { form, preserve: true };
  const boardVisibility = (Form.useWatch('access_mode', watchOptions) ||
    'shared') as RbacVisibility;
  const ownerIds = (Form.useWatch('owner_ids', watchOptions) || []) as string[];
  const groupGrants = (Form.useWatch('board_group_grants', watchOptions) ||
    []) as RbacPermissionValue['groupGrants'];
  const defaultOthersCan = Form.useWatch('default_others_can', watchOptions) || 'session';
  const defaultOthersFsAccess = Form.useWatch('default_others_fs_access', watchOptions) || 'read';

  const permissionValue: RbacPermissionValue = {
    visibility: boardVisibility,
    ownerIds,
    groupGrants,
    othersCan: boardVisibility === 'private' ? 'none' : defaultOthersCan,
    othersFsAccess: defaultOthersFsAccess,
  };

  const setPermissionField = <K extends keyof RbacPermissionValue>(
    key: K,
    value: RbacPermissionValue[K]
  ) => {
    if (key === 'visibility') form.setFieldsValue({ access_mode: value });
    if (key === 'ownerIds') form.setFieldsValue({ owner_ids: value });
    if (key === 'groupGrants') form.setFieldsValue({ board_group_grants: value });
    if (key === 'othersCan') form.setFieldsValue({ default_others_can: value });
    if (key === 'othersFsAccess') form.setFieldsValue({ default_others_fs_access: value });
  };

  const legacyPermissionsFields = (
    <Form layout="horizontal" colon={false} component={false}>
      <Alert
        type="info"
        showIcon
        description="Default branch permissions apply to new/aligned branches; branch overrides can still share individual branches."
        style={{ marginBottom: 24 }}
      />
      <RbacPermissionFields
        value={permissionValue}
        onChange={setPermissionField}
        allUsers={allUsers}
        allGroups={allGroups}
        canEdit
        canEditOwners={rbacEnabled}
        canEditGroups={rbacEnabled}
        ownerHelp="Manage board owners"
        groupsHelp="Inherited by aligned branches"
        visibilityLabel="Default branch permissions"
        othersCanLabel="Default others can"
        othersFsAccessLabel="Default filesystem access"
      />
      {!rbacEnabled && (
        <Form.Item wrapperCol={{ offset: 8, span: 16 }}>
          <Typography.Text type="secondary">
            Enable execution.branch_rbac to manage board owners and group grants.
          </Typography.Text>
        </Form.Item>
      )}
    </Form>
  );

  const permissionsFields = capabilityPolicyEditor ?? legacyPermissionsFields;

  // The background editor has several controls (preset gallery, gradient
  // helper) that write to the form directly rather than through a masked
  // input, so disabling its individual fields wouldn't actually stop an
  // edit. Swap in a read-only notice instead of fighting to disable every
  // control inside it.
  const cssFields = canEditGeneral ? (
    <BoardBackgroundEditor form={form} resetSignal={backgroundResetSignal} />
  ) : (
    <Alert
      type="info"
      showIcon
      icon={<LockOutlined />}
      message="You don't have permission to edit this board's appearance."
    />
  );

  return (
    <Tabs
      items={[
        { key: 'general', label: 'General', children: generalFields },
        { key: 'permissions', label: 'Permissions', children: permissionsFields },
        { key: 'css', label: 'CSS', children: cssFields },
        ...(extra ? [{ key: 'advanced', label: 'Advanced', children: extra }] : []),
      ]}
    />
  );
};
