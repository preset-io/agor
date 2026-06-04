import type { AgorClient } from '@agor-live/client';

function diffIds(currentIds: string[], nextIds: string[]) {
  const current = new Set(currentIds);
  const next = new Set(nextIds);
  return {
    add: nextIds.filter((id) => !current.has(id)),
    remove: currentIds.filter((id) => !next.has(id)),
  };
}

async function syncMembershipDiff(
  currentIds: string[],
  nextIds: string[],
  addMembership: (id: string) => Promise<unknown>,
  removeMembership: (id: string) => Promise<unknown>
) {
  const diff = diffIds(currentIds, nextIds);
  await Promise.all([
    ...diff.add.map((id) => addMembership(id)),
    ...diff.remove.map((id) => removeMembership(id)),
  ]);
}

export async function syncGroupMembersForGroup(
  client: AgorClient,
  groupId: string,
  currentUserIds: string[],
  nextUserIds: string[]
) {
  await syncMembershipDiff(
    currentUserIds,
    nextUserIds,
    (userId) => client.service('group-memberships').create({ group_id: groupId, user_id: userId }),
    (userId) => client.service('group-memberships').remove(userId, { query: { group_id: groupId } })
  );
}

export async function syncGroupsForUser(
  client: AgorClient,
  userId: string,
  currentGroupIds: string[],
  nextGroupIds: string[]
) {
  await syncMembershipDiff(
    currentGroupIds,
    nextGroupIds,
    (groupId) => client.service('group-memberships').create({ group_id: groupId, user_id: userId }),
    (groupId) =>
      client.service('group-memberships').remove(userId, { query: { group_id: groupId } })
  );
}
