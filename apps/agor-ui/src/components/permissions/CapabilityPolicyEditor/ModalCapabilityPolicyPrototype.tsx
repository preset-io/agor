import type {
  AgorClient,
  Board,
  BoardGroupGrantWithGroup,
  Branch,
  Group,
  GroupMembership,
  Session,
  User,
  UserID,
} from '@agor-live/client';
import { ReloadOutlined, SaveOutlined } from '@ant-design/icons';
import { Alert, Button, Divider, Flex, theme } from 'antd';
import { useEffect, useMemo, useState } from 'react';
import { BoardCapabilityPolicyForm } from './BoardCapabilityPolicyForm';
import { BranchCapabilityPolicyForm } from './BranchCapabilityPolicyForm';
import {
  buildBoardModalPrototypeDraft,
  buildBranchModalPrototypeDraft,
  buildModalPrototypeDirectory,
  type LegacyCapabilityPolicyGroupGrant,
} from './modalPrototypeModel';

function usePrototypeMemberships(client: AgorClient | null) {
  const [memberships, setMemberships] = useState<GroupMembership[]>([]);
  const [available, setAvailable] = useState(true);

  useEffect(() => {
    if (!client) {
      setMemberships([]);
      setAvailable(false);
      return;
    }
    let cancelled = false;
    client
      .service('group-memberships')
      .findAll({})
      .then((result) => {
        if (cancelled) return;
        setMemberships(result as GroupMembership[]);
        setAvailable(true);
      })
      .catch(() => {
        if (cancelled) return;
        // Membership inspection is admin-only today. The editor remains usable
        // for owners; only its local effective-access preview becomes partial.
        setMemberships([]);
        setAvailable(false);
      });
    return () => {
      cancelled = true;
    };
  }, [client]);

  return { memberships, available };
}

function useLocalPrototypeDraft<T>(initialDraft: T) {
  // Legacy modal data arrives through several independently loaded arrays.
  // Compare the derived value rather than their references so an unrelated
  // parent render cannot discard edits (or the local Apply confirmation).
  const initialDraftKey = JSON.stringify(initialDraft);
  const [draft, setDraft] = useState<T>(() => structuredClone(initialDraft));
  const [applied, setApplied] = useState(false);

  useEffect(() => {
    setDraft(JSON.parse(initialDraftKey) as T);
    setApplied(false);
  }, [initialDraftKey]);

  return { draft, setDraft, applied, setApplied };
}

function mergeKnownUsers(users: readonly User[], ...knownUserSets: readonly User[][]): User[] {
  const userById = new Map(users.map((user) => [user.user_id, user]));
  for (const knownUsers of knownUserSets) {
    for (const user of knownUsers) userById.set(user.user_id, user);
  }
  return [...userById.values()];
}

interface PrototypeFrameProps {
  children: React.ReactNode;
  membershipPreviewAvailable: boolean;
  applied: boolean;
  onApply: () => void;
  onReset: () => void;
}

const PrototypeFrame: React.FC<PrototypeFrameProps> = ({
  children,
  membershipPreviewAvailable,
  applied,
  onApply,
  onReset,
}) => {
  const { token } = theme.useToken();
  return (
    <Flex vertical gap={token.paddingMD} data-testid="modal-capability-policy-prototype">
      {!membershipPreviewAvailable && (
        <Alert
          type="info"
          showIcon
          description="Group membership preview is unavailable. Effective access can show direct entries and Others only."
        />
      )}
      {applied && (
        <Alert
          type="success"
          showIcon
          closable
          onClose={() => undefined}
          description="Preview updated."
        />
      )}
      {children}
      <Divider style={{ marginBlock: 0 }} />
      <Flex justify="flex-end" gap={token.paddingXS} wrap>
        <Button icon={<ReloadOutlined />} onClick={onReset} aria-label="Reset permissions preview">
          Reset
        </Button>
        <Button
          type="primary"
          icon={<SaveOutlined />}
          onClick={onApply}
          aria-label="Apply permissions preview"
        >
          Apply preview
        </Button>
      </Flex>
    </Flex>
  );
};

interface BoardCapabilityPolicyModalPrototypeProps {
  board: Board;
  client: AgorClient | null;
  owners: User[];
  groupGrants: BoardGroupGrantWithGroup[];
  users: User[];
  groups: Group[];
  currentUser?: User | null;
}

export const BoardCapabilityPolicyModalPrototype: React.FC<
  BoardCapabilityPolicyModalPrototypeProps
> = ({ board, client, owners, groupGrants, users, groups, currentUser }) => {
  const { memberships, available } = usePrototypeMemberships(client);
  const currentUserId = (currentUser?.user_id || board.created_by || owners[0]?.user_id) as UserID;
  const initialDraft = useMemo(
    () => buildBoardModalPrototypeDraft({ board, owners, groupGrants, currentUserId }),
    [board, owners, groupGrants, currentUserId]
  );
  const { draft, setDraft, applied, setApplied } = useLocalPrototypeDraft(initialDraft);
  const knownUsers = useMemo(
    () => mergeKnownUsers(users, owners, currentUser ? [currentUser] : []),
    [users, owners, currentUser]
  );
  const directory = useMemo(
    () =>
      buildModalPrototypeDirectory({
        users: knownUsers,
        groups,
        memberships,
        requiredUserIds: [
          draft.primary_owner_user_id,
          currentUserId,
          ...owners.map((owner) => owner.user_id),
        ],
      }),
    [knownUsers, groups, memberships, draft.primary_owner_user_id, currentUserId, owners]
  );

  return (
    <PrototypeFrame
      membershipPreviewAvailable={available}
      applied={applied}
      onApply={() => setApplied(true)}
      onReset={() => {
        setDraft(structuredClone(initialDraft));
        setApplied(false);
      }}
    >
      <BoardCapabilityPolicyForm
        value={draft}
        onChange={(value) => {
          setDraft(value);
          setApplied(false);
        }}
        principals={directory.principals}
        subjects={directory.subjects}
        sampleBranchOwnerUserId={draft.primary_owner_user_id}
        currentUserId={currentUserId}
      />
    </PrototypeFrame>
  );
};

interface BranchCapabilityPolicyModalPrototypeProps {
  branch: Branch;
  board?: Board | null;
  client: AgorClient | null;
  currentUser?: User | null;
  owners: User[];
  groupGrants: LegacyCapabilityPolicyGroupGrant[];
  boardGroupGrants: BoardGroupGrantWithGroup[];
  users: User[];
  groups: Group[];
  sessions: Session[];
}

export const BranchCapabilityPolicyModalPrototype: React.FC<
  BranchCapabilityPolicyModalPrototypeProps
> = ({
  branch,
  board,
  client,
  currentUser,
  owners,
  groupGrants,
  boardGroupGrants,
  users,
  groups,
  sessions,
}) => {
  const { memberships, available } = usePrototypeMemberships(client);
  const currentUserId = (currentUser?.user_id || branch.created_by) as UserID;
  const initialDraft = useMemo(
    () =>
      buildBranchModalPrototypeDraft({
        branch,
        board,
        owners,
        groupGrants,
        boardGroupGrants,
        currentUserId,
        sessions,
      }),
    [branch, board, owners, groupGrants, boardGroupGrants, currentUserId, sessions]
  );
  const { draft, setDraft, applied, setApplied } = useLocalPrototypeDraft(initialDraft);
  const knownUsers = useMemo(
    () => mergeKnownUsers(users, owners, currentUser ? [currentUser] : []),
    [users, owners, currentUser]
  );
  const requiredUserIds = useMemo(
    () => [
      draft.primary_owner_user_id,
      currentUserId,
      ...owners.map((owner) => owner.user_id),
      ...sessions.map((session) => session.created_by),
    ],
    [draft.primary_owner_user_id, currentUserId, owners, sessions]
  );
  const directory = useMemo(
    () => buildModalPrototypeDirectory({ users: knownUsers, groups, memberships, requiredUserIds }),
    [knownUsers, groups, memberships, requiredUserIds]
  );

  return (
    <PrototypeFrame
      membershipPreviewAvailable={available}
      applied={applied}
      onApply={() => setApplied(true)}
      onReset={() => {
        setDraft(structuredClone(initialDraft));
        setApplied(false);
      }}
    >
      <BranchCapabilityPolicyForm
        value={draft}
        onChange={(value) => {
          setDraft(value);
          setApplied(false);
        }}
        principals={directory.principals}
        subjects={directory.subjects}
        currentUserId={currentUserId}
        personalSessionSharingWorkspaceEnabled
      />
    </PrototypeFrame>
  );
};
