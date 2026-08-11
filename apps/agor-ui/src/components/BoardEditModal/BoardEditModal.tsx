import type {
  AgorClient,
  Board,
  BoardGroupGrantWithGroup,
  BranchFsAccessLevel,
  BranchPermissionLevel,
  Group,
  User,
  UUID,
} from '@agor-live/client';
import { Alert, Form, Modal, Skeleton } from 'antd';
import { useEffect, useState } from 'react';
import { useThemedMessage } from '@/utils/message';
import { BoardFormFields, extractBoardFormValues } from '../forms/BoardFormFields';
import { JSONEditor, validateJSON } from '../JSONEditor';

export interface BoardEditModalProps {
  board: Board | null;
  client: AgorClient | null;
  open: boolean;
  onClose: () => void;
  onUpdate?: (boardId: string, updates: Partial<Board>) => unknown;
}

/** The single board-settings editor used by Settings and the navbar shortcut. */
export function BoardEditModal({ board, client, open, onClose, onUpdate }: BoardEditModalProps) {
  const [form] = Form.useForm();
  const { showError } = useThemedMessage();
  const [loading, setLoading] = useState(false);
  const [rbacEnabled, setRbacEnabled] = useState(false);
  const [allUsers, setAllUsers] = useState<User[]>([]);
  const [allGroups, setAllGroups] = useState<Group[]>([]);
  const [loadedBoard, setLoadedBoard] = useState<Board | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!open || !board) return;
    let cancelled = false;
    setLoading(true);
    setLoadError(null);
    setLoadedBoard(null);

    // Re-read the board as the modal opens. The selector uses a lean board list,
    // while this form must always start from the full, latest representation.
    const load = async () => {
      try {
        const fresh = client ? await client.service('boards').get(board.board_id) : board;
        let ownerIds: string[] = [];
        let grants: Array<{ group_id: string; can: string; fs_access?: string }> = [];
        if (client) {
          try {
            const [users, groups, owners, groupGrants] = await Promise.all([
              client.service('users').findAll({}),
              client.service('groups').findAll({ query: { archived: false } }),
              client.service('boards/:id/owners').find({ route: { id: board.board_id } }),
              client.service('boards/:id/group-grants').find({ route: { id: board.board_id } }),
            ]);
            if (cancelled) return;
            setRbacEnabled(true);
            setAllUsers(users as User[]);
            setAllGroups(groups as Group[]);
            ownerIds = (owners as User[]).map((user) => user.user_id);
            grants = (groupGrants as BoardGroupGrantWithGroup[]).map((grant) => ({
              group_id: grant.group_id,
              can: grant.can,
              fs_access: grant.fs_access,
            }));
          } catch (error) {
            if ((error as { code?: number })?.code !== 404) throw error;
            // Owner/group routes intentionally do not exist when RBAC is disabled.
            setRbacEnabled(false);
            setAllUsers([]);
            setAllGroups([]);
          }
        }
        if (cancelled) return;
        if (ownerIds.length === 0 && fresh.created_by) ownerIds = [fresh.created_by];
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
          default_dangerously_allow_session_sharing: Boolean(
            fresh.default_dangerously_allow_session_sharing
          ),
          owner_ids: ownerIds,
          board_group_grants: grants,
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

  const syncPermissions = async () => {
    if (!client || !board || !rbacEnabled) return;
    const id = board.board_id as UUID;
    const values = form.getFieldsValue(true);
    const desiredOwners = (values.owner_ids || []) as UUID[];
    const desiredGrants = (
      values.access_mode === 'private' ? [] : values.board_group_grants || []
    ) as Array<{ group_id: string; can: BranchPermissionLevel; fs_access?: BranchFsAccessLevel }>;
    const owners = (await client.service('boards/:id/owners').find({ route: { id } })) as User[];
    const currentOwnerIds = owners.map((user) => user.user_id as UUID);
    const currentGrants = (await client
      .service('boards/:id/group-grants')
      .find({ route: { id } })) as BoardGroupGrantWithGroup[];
    const desiredGroups = new Set(desiredGrants.map((grant) => grant.group_id));
    await Promise.all([
      ...desiredOwners
        .filter((userId) => !currentOwnerIds.includes(userId))
        .map((user_id) =>
          client.service('boards/:id/owners').create({ user_id }, { route: { id } })
        ),
      ...currentOwnerIds
        .filter((userId) => !desiredOwners.includes(userId))
        .map((userId) => client.service('boards/:id/owners').remove(userId, { route: { id } })),
      ...desiredGrants.map((grant) =>
        client.service('boards/:id/group-grants').create(grant, { route: { id } })
      ),
      ...currentGrants
        .filter((grant) => !desiredGroups.has(grant.group_id))
        .map((grant) =>
          client.service('boards/:id/group-grants').remove(grant.group_id, { route: { id } })
        ),
    ]);
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
      const values = form.getFieldsValue(true);
      if (values.access_mode === 'private' && (values.owner_ids || []).length !== 1) {
        showError('Private boards must have exactly one private user');
        return;
      }
      const updated = await onUpdate?.(board.board_id, extractBoardFormValues(form));
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
            rbacEnabled={rbacEnabled}
            allUsers={allUsers}
            allGroups={allGroups}
            extra={
              <Form.Item
                label="Custom Context (JSON)"
                name="custom_context"
                help="Add custom fields for use in zone trigger templates (e.g., {{ board.context.yourField }})"
                rules={[{ validator: validateJSON }]}
              >
                <JSONEditor placeholder='{"team": "Backend", "sprint": 42}' rows={4} />
              </Form.Item>
            }
          />
        </Form>
      )}
    </Modal>
  );
}
