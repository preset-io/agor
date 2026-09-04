import { normalizeZoneLayoutPolicy, zoneLayoutBinding } from '@agor/core/layout/zone-layout';
import type { BoardZoneLayoutDefaultsExpected } from '@agor/core/types';
import type {
  AgorClient,
  Board,
  BoardCapabilityPolicies,
  CapabilityPolicyWorkspacePreferences,
  EffectiveCapabilityPolicyAccess,
  Group,
  User,
  ZoneLayoutPolicy,
} from '@agor-live/client';
import { Alert, Checkbox, Form, Modal, Skeleton, Space, Typography } from 'antd';
import { useEffect, useMemo, useState } from 'react';
import { useThemedMessage } from '@/utils/message';
import { useAuthConfig } from '../../hooks/useAuthConfig';
import { useAgorStore } from '../../store/agorStore';
import { selectUserById } from '../../store/selectors';
import { BoardFormFields, extractBoardFormValues } from '../forms/BoardFormFields';
import { JSONEditor, validateJSON } from '../JSONEditor';
import { BoardCapabilityPolicyModalEditor } from '../permissions/CapabilityPolicyEditor';
import { ZoneLayoutPolicyEditor } from '../SessionCanvas/canvas/ZoneLayoutPolicyEditor';

export interface BoardEditModalProps {
  board: Board | null;
  client: AgorClient | null;
  open: boolean;
  onClose: () => void;
  onUpdate?: (boardId: string, updates: Partial<Board>) => unknown;
  currentUser?: User | null;
}

/** The single board-settings editor used by Settings and the navbar shortcut. */
export function BoardEditModal({
  board,
  client,
  open,
  onClose,
  onUpdate,
  currentUser,
}: BoardEditModalProps) {
  const userById = useAgorStore(selectUserById);
  const { featuresConfig } = useAuthConfig();
  // Do not mount the normalized policy editor against a daemon that has not
  // explicitly enabled the feature. Legacy board permission fields remain
  // available in that mode, matching the pre-remodel UI behavior.
  const branchRbacEnabled = featuresConfig?.branchRbac === true;
  const [form] = Form.useForm();
  const { showError } = useThemedMessage();
  const [loading, setLoading] = useState(false);
  const [allUsers, setAllUsers] = useState<User[]>([]);
  const [allGroups, setAllGroups] = useState<Group[]>([]);
  const [policy, setPolicy] = useState<BoardCapabilityPolicies | null>(null);
  const [workspacePreferences, setWorkspacePreferences] =
    useState<CapabilityPolicyWorkspacePreferences>({ session_sharing_enabled: false });
  const [effectiveAccess, setEffectiveAccess] = useState<EffectiveCapabilityPolicyAccess | null>(
    null
  );
  const [loadedBoard, setLoadedBoard] = useState<Board | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [zoneDefaults, setZoneDefaults] = useState<ZoneLayoutPolicy>(() =>
    normalizeZoneLayoutPolicy(undefined)
  );
  const [initialZoneDefaults, setInitialZoneDefaults] = useState<ZoneLayoutPolicy>(() =>
    normalizeZoneLayoutPolicy(undefined)
  );
  const [zoneDefaultsExpected, setZoneDefaultsExpected] =
    useState<BoardZoneLayoutDefaultsExpected | null>(null);
  const [applyZoneDefaultsToExisting, setApplyZoneDefaultsToExisting] = useState(false);
  const permissionUsers = useMemo(() => {
    const knownUsers = new Map(userById);
    for (const user of allUsers) knownUsers.set(user.user_id, user);
    return [...knownUsers.values()];
  }, [userById, allUsers]);

  useEffect(() => {
    if (!open || !board) return;
    let cancelled = false;
    setLoading(true);
    setLoadError(null);
    setLoadedBoard(null);
    setPolicy(null);
    setEffectiveAccess(null);

    // Re-read the board as the modal opens. The selector uses a lean board list,
    // while this form must always start from the full, latest representation.
    const load = async () => {
      try {
        if (!client) throw new Error('Agor client is unavailable');
        const fresh = await client.service('boards').get(board.board_id);
        // The legacy board permissions tab still needs the principal
        // directory when normalized RBAC is disabled. Only the normalized
        // policy package and workspace preference are feature-gated.
        const [usersResult, groupsResult] = await Promise.allSettled([
          client.service('users').findAll({}),
          client.service('groups').findAll({ query: { archived: false } }),
        ]);
        if (cancelled) return;

        if (usersResult.status === 'fulfilled') {
          setAllUsers(usersResult.value as User[]);
        } else {
          setAllUsers([]);
          console.warn('Failed to load users for board permissions:', usersResult.reason);
        }
        if (groupsResult.status === 'fulfilled') {
          setAllGroups(groupsResult.value as Group[]);
        } else {
          setAllGroups([]);
          console.warn('Failed to load groups for board permissions:', groupsResult.reason);
        }

        if (branchRbacEnabled) {
          const [policyResult, preferencesResult, accessResult] = await Promise.allSettled([
            client.service('boards/:id/permissions').find({ route: { id: board.board_id } }),
            client.service('workspace-preferences').find(),
            client.service('boards/:id/effective-access').find({ route: { id: board.board_id } }),
          ]);
          if (cancelled) return;
          if (policyResult.status === 'fulfilled') {
            setPolicy(policyResult.value);
          } else {
            throw policyResult.reason;
          }
          if (preferencesResult.status === 'fulfilled') {
            setWorkspacePreferences(preferencesResult.value);
          }
          // A failed fetch here fails closed: canEditGeneral (below) treats a
          // null effectiveAccess as "no board.edit capability", same as an
          // explicit denial.
          setEffectiveAccess(
            accessResult.status === 'fulfilled'
              ? (accessResult.value as unknown as EffectiveCapabilityPolicyAccess)
              : null
          );
        } else {
          setPolicy(null);
          setWorkspacePreferences({ session_sharing_enabled: false });
          setEffectiveAccess(null);
        }
        if (cancelled) return;
        // Populate the form BEFORE exposing loadedBoard so the background
        // editor mounts against fully-initialized field values (rather than
        // relying on render batching). loadedBoard is set last, below.
        form.resetFields();
        const normalizedZoneDefaults = normalizeZoneLayoutPolicy(fresh.zone_layout_defaults);
        setZoneDefaults(normalizedZoneDefaults);
        setInitialZoneDefaults(normalizedZoneDefaults);
        setZoneDefaultsExpected({
          defaults: normalizedZoneDefaults,
          zones: Object.fromEntries(
            Object.entries(fresh.objects ?? {}).flatMap(([objectId, object]) =>
              object.type === 'zone'
                ? [
                    [
                      objectId,
                      {
                        binding: zoneLayoutBinding(object),
                        layout: normalizeZoneLayoutPolicy(object.layout),
                      },
                    ] as const,
                  ]
                : []
            )
          ),
        });
        setApplyZoneDefaultsToExisting(false);
        form.setFieldsValue({
          name: fresh.name,
          icon: fresh.icon,
          description: fresh.description,
          background_color: fresh.background_color,
          custom_css: fresh.custom_css,
          access_mode: fresh.access_mode || 'shared',
          default_others_can: fresh.default_others_can || 'session',
          default_others_fs_access: fresh.default_others_fs_access || 'read',
          owner_ids: fresh.created_by ? [fresh.created_by] : [],
          board_group_grants: [],
          custom_context: fresh.custom_context ? JSON.stringify(fresh.custom_context, null, 2) : '',
        });
        // Expose the loaded board last: this is what un-gates the form render.
        setLoadedBoard(fresh);
      } catch (error) {
        if (!cancelled) {
          const detail = error instanceof Error ? error.message : String(error);
          setLoadError(`Could not load current board settings: ${detail}`);
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    };
    void load();
    return () => {
      cancelled = true;
    };
  }, [board, branchRbacEnabled, client, form, open]);

  // Preserve the legacy open-RBAC behavior while the normalized policy
  // feature is disabled: every board mutator has always been allowed to
  // save general settings there, and the daemon-side authorization hook
  // is a no-op in that mode too. The server remains authoritative for
  // every write either way — this only prevents typing into fields that
  // are certain to 403.
  const canEditGeneral = branchRbacEnabled
    ? Boolean(effectiveAccess?.capabilities.includes('board.edit'))
    : true;

  const syncPermissions = async () => {
    if (!branchRbacEnabled || !client || !board || !policy) return;
    const saved = await client
      .service('boards/:id/permissions')
      .patch(null, policy, { route: { id: board.board_id } });
    setPolicy(saved);
  };

  const close = () => {
    form.resetFields();
    onClose();
  };

  const save = async () => {
    if (!board) return;
    try {
      setSaving(true);
      await form.validateFields();
      // The normalized permission service is the only supported persistence
      // route for board access. The legacy fields may still be rendered while
      // the feature flag is off, but generic board writes reject them, so they
      // must never hitchhike on an otherwise unrelated settings/defaults save.
      const formValues = extractBoardFormValues(form, {
        includeLegacyPermissions: false,
      });
      const generalSettingsChanged = Object.entries(formValues).some(
        ([field, value]) =>
          JSON.stringify(value) !== JSON.stringify(loadedBoard?.[field as keyof Board])
      );
      if (generalSettingsChanged) {
        const updated = await onUpdate?.(board.board_id, formValues);
        if (updated === false) return;
      }
      if (
        client &&
        zoneDefaultsExpected &&
        (applyZoneDefaultsToExisting ||
          JSON.stringify(zoneDefaults) !== JSON.stringify(initialZoneDefaults))
      ) {
        await client.service('boards').patch(board.board_id, {
          _action: 'setZoneLayoutDefaults',
          defaults: normalizeZoneLayoutPolicy(zoneDefaults),
          applyToExisting: applyZoneDefaultsToExisting,
          expected: zoneDefaultsExpected,
        } as unknown as Partial<Board>);
      }
      await syncPermissions();
      close();
    } catch (error) {
      if (error instanceof Error) showError(`Failed to update board: ${error.message}`);
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal
      title="Edit Board"
      open={open}
      width={760}
      confirmLoading={loading || saving}
      okButtonProps={{ disabled: loading || saving || Boolean(loadError) }}
      onOk={() => void save()}
      onCancel={close}
      okText="Save"
      destroyOnHidden
    >
      {loadError ? (
        <Alert type="error" showIcon title="Board settings unavailable" description={loadError} />
      ) : !loadedBoard ? (
        // Render the form only once the full board has loaded, so its fields —
        // including the background editor's mode — initialize from real values
        // rather than the empty pre-load state (the cause of the mode/checkbox
        // resetting on reopen).
        <Skeleton active paragraph={{ rows: 6 }} style={{ marginTop: 16 }} />
      ) : (
        <Form form={form} layout="vertical" preserve style={{ marginTop: 16 }}>
          <BoardFormFields
            key={loadedBoard.board_id}
            form={form}
            backgroundResetSignal={loadedBoard.board_id}
            rbacEnabled={branchRbacEnabled}
            allUsers={allUsers}
            allGroups={allGroups}
            canEditGeneral={canEditGeneral}
            zoneDefaultsEditor={
              <Space orientation="vertical" size="middle" style={{ width: '100%' }}>
                <Alert
                  type="info"
                  showIcon
                  title="One policy for new and inherited zones"
                  description="New zones follow these defaults. Existing zones remain explicit overrides unless you intentionally apply the policy below; inherited zones continue following future changes."
                />
                <ZoneLayoutPolicyEditor
                  value={zoneDefaults}
                  onChange={setZoneDefaults}
                  disabled={!canEditGeneral}
                  idPrefix="board-zone-defaults"
                />
                <Checkbox
                  checked={applyZoneDefaultsToExisting}
                  disabled={!canEditGeneral}
                  onChange={(event) => setApplyZoneDefaultsToExisting(event.target.checked)}
                >
                  Apply to existing zones
                </Checkbox>
                <Typography.Text type="secondary">
                  This resets every existing zone to these values and makes it follow the board
                  defaults. Zone names, colors, prompts, positions, sizes, and locks are preserved.
                  Clear this checkbox to preserve current overrides.
                </Typography.Text>
              </Space>
            }
            capabilityPolicyEditor={
              branchRbacEnabled ? (
                policy ? (
                  <BoardCapabilityPolicyModalEditor
                    value={policy}
                    onChange={setPolicy}
                    client={client}
                    users={permissionUsers}
                    groups={allGroups}
                    currentUser={currentUser}
                    workspacePreferences={workspacePreferences}
                  />
                ) : (
                  <Alert type="error" showIcon description="Permissions are unavailable." />
                )
              ) : undefined
            }
            extra={
              <Form.Item
                label="Custom Context (JSON)"
                name="custom_context"
                help="Add custom fields for use in zone trigger templates (e.g., {{ board.context.yourField }})"
                rules={[{ validator: validateJSON }]}
              >
                <JSONEditor
                  placeholder='{"team": "Backend", "sprint": 42}'
                  rows={4}
                  disabled={!canEditGeneral}
                />
              </Form.Item>
            }
          />
        </Form>
      )}
    </Modal>
  );
}
