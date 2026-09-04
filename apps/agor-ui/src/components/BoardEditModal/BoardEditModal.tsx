import type {
  AgorClient,
  Board,
  BoardCapabilityPolicies,
  CapabilityPolicyWorkspacePreferences,
  EffectiveCapabilityPolicyAccess,
  Group,
  User,
} from '@agor-live/client';
import { Alert, Form, Modal, Skeleton } from 'antd';
import { useEffect, useMemo, useState } from 'react';
import { useThemedMessage } from '@/utils/message';
import { useAgorStore } from '../../store/agorStore';
import { selectUserById } from '../../store/selectors';
import { BoardFormFields, extractBoardFormValues } from '../forms/BoardFormFields';
import { JSONEditor, validateJSON } from '../JSONEditor';
import { BoardCapabilityPolicyModalEditor } from '../permissions/CapabilityPolicyEditor';

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
        if (cancelled) return;
        // Populate the form BEFORE exposing loadedBoard so the background
        // editor mounts against fully-initialized field values (rather than
        // relying on render batching). loadedBoard is set last, below.
        form.resetFields();
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
  }, [board, client, form, open]);

  const canEditGeneral = Boolean(effectiveAccess?.capabilities.includes('board.edit'));

  const syncPermissions = async () => {
    if (!client || !board || !policy) return;
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
      const updated = await onUpdate?.(
        board.board_id,
        extractBoardFormValues(form, { includeLegacyPermissions: false })
      );
      if (updated === false) return;
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
            rbacEnabled
            allUsers={allUsers}
            allGroups={allGroups}
            canEditGeneral={canEditGeneral}
            capabilityPolicyEditor={
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
