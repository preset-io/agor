import type { Board, Group, User } from '@agor-live/client';
import type { FormInstance } from 'antd';
import { Alert, Checkbox, ColorPicker, Form, Input, Select, Space, Tabs, Typography } from 'antd';
import { useState } from 'react';
import { FormEmojiPickerInput } from '../EmojiPickerInput';
import {
  RbacPermissionFields,
  type RbacPermissionValue,
  type RbacVisibility,
} from '../permissions/RbacPermissionFields';
import { BACKGROUND_PRESETS } from './boardBackgroundPresets';

/**
 * Animation CSS presets — each sets background-size + animation + @keyframes.
 * Designed to pair with gradient backgrounds from BACKGROUND_PRESETS.
 */
export const ANIMATION_PRESETS = [
  {
    label: 'Slow gradient shift (12s)',
    value: `background-size: 400% 400%;
animation: agorGradientShift 12s ease infinite;

@keyframes agorGradientShift {
  0%, 100% { background-position: 0% 50%; }
  50% { background-position: 100% 50%; }
}`,
  },
  {
    label: 'Fast gradient shift (4s)',
    value: `background-size: 400% 400%;
animation: agorGradientFast 4s ease infinite;

@keyframes agorGradientFast {
  0%, 100% { background-position: 0% 50%; }
  50% { background-position: 100% 50%; }
}`,
  },
  {
    label: 'Diagonal sweep (8s)',
    value: `background-size: 400% 400%;
animation: agorDiagonalSweep 8s linear infinite;

@keyframes agorDiagonalSweep {
  0% { background-position: 0% 0%; }
  50% { background-position: 100% 100%; }
  100% { background-position: 0% 0%; }
}`,
  },
  {
    label: 'Pulse zoom (6s)',
    value: `background-size: 200% 200%;
animation: agorPulse 6s ease-in-out infinite;

@keyframes agorPulse {
  0%, 100% { background-size: 200% 200%; background-position: center; }
  50% { background-size: 300% 300%; background-position: center; }
}`,
  },
  {
    label: 'Horizontal scroll (20s)',
    value: `background-size: 200% 100%;
animation: agorHScroll 20s linear infinite;

@keyframes agorHScroll {
  0% { background-position: 0% 50%; }
  100% { background-position: 200% 50%; }
}`,
  },
  {
    label: 'Rotate (conic, 10s)',
    value: `animation: agorRotate 10s linear infinite;

@keyframes agorRotate {
  0% { filter: hue-rotate(0deg); }
  100% { filter: hue-rotate(360deg); }
}`,
  },
];

/** Detect if a background value is custom CSS (not a simple hex color or rgba) */
export function isCustomCSS(value: string | undefined | null): boolean {
  if (!value) return false;
  return !value.match(/^#[0-9a-fA-F]{3,8}$/) && !value.match(/^rgba?\(/);
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
export function extractBoardFormValues(form: FormInstance): Partial<Board> {
  const values = form.getFieldsValue(true);
  const bgColor = values.background_color;
  return {
    name: values.name,
    icon: values.icon || '📋',
    description: values.description,
    background_color: bgColor
      ? typeof bgColor === 'string'
        ? bgColor
        : bgColor.toHexString()
      : null,
    custom_css: values.custom_css || null,
    access_mode: values.access_mode || 'shared',
    default_others_can:
      values.access_mode === 'private' ? 'none' : values.default_others_can || 'session',
    default_others_fs_access: values.default_others_fs_access || 'read',
    default_dangerously_allow_session_sharing: Boolean(
      values.default_dangerously_allow_session_sharing
    ),
    custom_context: values.custom_context ? JSON.parse(values.custom_context) : null,
  } as unknown as Partial<Board>;
}

export interface BoardFormFieldsProps {
  form: FormInstance;
  /** Whether to auto-focus the name input */
  autoFocus?: boolean;
  /** Extra content rendered inside the "Advanced" collapse panel */
  extra?: React.ReactNode;
  /** Initial custom CSS mode — auto-detected from board values if not provided */
  initialCustomCSS?: boolean;
  rbacEnabled?: boolean;
  allUsers?: User[];
  allGroups?: Group[];
}

/**
 * Shared board form fields used in the CreateDialog BoardTab
 * and the SettingsModal BoardsTable create/edit modals.
 *
 * Renders: Name, Description, and collapsible CSS / Advanced sections.
 * Manages useCustomCSS state internally.
 * Does NOT render a <Form> wrapper — the parent owns the form instance.
 */
export const BoardFormFields: React.FC<BoardFormFieldsProps> = ({
  form,
  autoFocus,
  extra,
  initialCustomCSS = false,
  rbacEnabled = false,
  allUsers = [],
  allGroups = [],
}) => {
  const [useCustomCSS, setUseCustomCSS] = useState(initialCustomCSS);
  const backgroundColor = Form.useWatch('background_color', { form, preserve: true });

  const generalFields = (
    <>
      <Form.Item label="Name" required style={{ marginBottom: 24 }}>
        <Space.Compact style={{ display: 'flex' }}>
          <FormEmojiPickerInput form={form} fieldName="icon" defaultEmoji="📋" />
          <Form.Item
            name="name"
            noStyle
            rules={[{ required: true, message: 'Please enter a board name' }]}
          >
            <Input placeholder="My Board" style={{ flex: 1 }} autoFocus={autoFocus} />
          </Form.Item>
        </Space.Compact>
      </Form.Item>

      <Form.Item label="Description" name="description">
        <Input.TextArea placeholder="Optional description..." rows={3} />
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
  const defaultSessionSharing = Boolean(
    Form.useWatch('default_dangerously_allow_session_sharing', watchOptions)
  );

  const permissionValue: RbacPermissionValue = {
    visibility: boardVisibility,
    ownerIds,
    groupGrants,
    othersCan: boardVisibility === 'private' ? 'none' : defaultOthersCan,
    othersFsAccess: defaultOthersFsAccess,
    allowSessionSharing: defaultSessionSharing,
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
    if (key === 'allowSessionSharing') {
      form.setFieldsValue({ default_dangerously_allow_session_sharing: value });
    }
  };

  const permissionsFields = (
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

  const cssFields = (
    <>
      <Space direction="vertical" style={{ width: '100%', marginBottom: 16 }}>
        <Checkbox
          checked={useCustomCSS}
          onChange={(e) => {
            setUseCustomCSS(e.target.checked);
            if (e.target.checked) {
              const current = form.getFieldValue('background_color');
              if (current && typeof current !== 'string') {
                form.setFieldsValue({ background_color: current.toHexString() });
              }
            }
          }}
        >
          Use custom CSS background
        </Checkbox>

        {!useCustomCSS ? (
          <Form.Item name="background_color" noStyle>
            <ColorPicker showText format="hex" allowClear />
          </Form.Item>
        ) : (
          <>
            <Select
              placeholder="Load a preset..."
              style={{ width: '100%', marginBottom: 8 }}
              allowClear
              showSearch
              options={BACKGROUND_PRESETS}
              value={
                BACKGROUND_PRESETS.some((preset) => preset.value === backgroundColor)
                  ? backgroundColor
                  : undefined
              }
              onChange={(value) => {
                if (value) form.setFieldsValue({ background_color: value });
              }}
            />
            <Form.Item name="background_color" noStyle>
              <Input.TextArea
                placeholder="Enter custom CSS background value (gradients, patterns, etc.)"
                rows={3}
                style={{ fontFamily: 'monospace', fontSize: '12px' }}
              />
            </Form.Item>
          </>
        )}
      </Space>

      {useCustomCSS && (
        <Space direction="vertical" style={{ width: '100%' }}>
          <Typography.Text strong style={{ fontSize: '13px' }}>
            Animation CSS
          </Typography.Text>
          <Select
            placeholder="Load an animation preset..."
            style={{ width: '100%', marginBottom: 8 }}
            allowClear
            showSearch
            options={ANIMATION_PRESETS}
            onChange={(value) => {
              if (value) form.setFieldsValue({ custom_css: value });
            }}
          />
          <Form.Item name="custom_css" noStyle>
            <Input.TextArea rows={6} style={{ fontFamily: 'monospace', fontSize: '12px' }} />
          </Form.Item>
        </Space>
      )}
    </>
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
