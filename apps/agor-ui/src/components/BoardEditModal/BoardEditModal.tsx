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
import { Form, Modal } from 'antd';
import { useEffect, useState } from 'react';
import { useThemedMessage } from '@/utils/message';
import { BoardFormFields, extractBoardFormValues, isCustomCSS } from '../forms/BoardFormFields';
import { JSONEditor, validateJSON } from '../JSONEditor';

export interface BoardEditModalProps {
  board: Board | null;
  client: AgorClient | null;
  open: boolean;
  onClose: () => void;
  onUpdate?: (boardId: string, updates: Partial<Board>) => void | Promise<void>;
}

/** The single board-settings editor used by Settings and the navbar shortcut. */
export function BoardEditModal({ board, client, open, onClose, onUpdate }: BoardEditModalProps) {
  const [form] = Form.useForm();
  const { showError } = useThemedMessage();
  const [loading, setLoading] = useState(false);
  const [rbacEnabled, setRbacEnabled] = useState(false);
  const [allUsers, setAllUsers] = useState<User[]>([]);
  const [allGroups, setAllGroups] = useState<Group[]>([]);

  useEffect(() => {
    if (!open || !board) return;
    let cancelled = false;
    setLoading(true);

    // Re-read the board as the modal opens. The selector uses a lean board list,
    // while this form must always start from the full, latest representation.
    const load = async () => {
      let fresh = board;
      let ownerIds: string[] = [];
      let grants: Array<{ group_id: string; can: string; fs_access?: string }> = [];
      try {
        if (client) fresh = await client.service('boards').get(board.board_id);
        if (client) {
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
        }
      } catch (error) {
        // Owner/group routes intentionally do not exist when RBAC is disabled.
        setRbacEnabled(false);
        setAllUsers([]);
        setAllGroups([]);
        console.warn('Board RBAC metadata unavailable:', error);
      }
      if (cancelled) return;
      if (ownerIds.length === 0 && fresh.created_by) ownerIds = [fresh.created_by];
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
      setLoading(false);
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
      await form.validateFields();
      const values = form.getFieldsValue(true);
      if (values.access_mode === 'private' && (values.owner_ids || []).length !== 1) {
        showError('Private boards must have exactly one private user');
        return;
      }
      await onUpdate?.(board.board_id, extractBoardFormValues(form));
      await syncPermissions();
      close();
    } catch (error) {
      if (error instanceof Error) showError(`Failed to update board permissions: ${error.message}`);
    }
  };

  return (
    <Modal
      title="Edit Board"
      open={open}
      width={760}
      confirmLoading={loading}
      okButtonProps={{ disabled: loading }}
      onOk={() => void save()}
      onCancel={close}
      okText="Save"
      destroyOnHidden
    >
      <Form form={form} layout="vertical" preserve style={{ marginTop: 16 }}>
        <BoardFormFields
          key={board?.board_id}
          form={form}
          initialCustomCSS={isCustomCSS(board?.background_color) || Boolean(board?.custom_css)}
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
    </Modal>
  );
}
