import {
  BranchRepository,
  KnowledgeNamespaceRepository,
  shortId,
  type TenantScopeAwareDatabase,
} from '@agor/core/db';
import type {
  Branch,
  BranchID,
  KnowledgeNamespace,
  TeammateKnowledgeConfig,
  UserID,
} from '@agor/core/types';
import { getTeammateConfig, isTeammate } from '@agor/core/types';

export const TEAMMATE_MEMORY_PATH_TEMPLATE = 'memory/{{YYYY-MM-DD}}.md' as const;
export const TEAMMATE_NAMESPACE_MISSING_MESSAGE = 'namespace for this agent is not set up';

function teammateNamespaceMetadata(branchId: BranchID) {
  return {
    teammate: {
      primary: true,
      branch_id: branchId,
      memory_path_template: TEAMMATE_MEMORY_PATH_TEMPLATE,
      docs_root: 'docs/',
      scratchpad_root: 'scratchpad/',
      skills_root: 'skills/',
    },
  };
}

function isPrimaryTeammateNamespace(namespace: KnowledgeNamespace, branchId: BranchID): boolean {
  const teammate = namespace.metadata?.teammate ?? namespace.metadata?.assistant;
  return (
    namespace.branch_id === branchId &&
    teammate !== null &&
    typeof teammate === 'object' &&
    (teammate as Record<string, unknown>).primary === true
  );
}

function teammateKbPatch(namespace: KnowledgeNamespace, previous?: TeammateKnowledgeConfig) {
  return {
    primary_namespace_id: namespace.namespace_id,
    primary_namespace_slug: namespace.slug,
    memory_path_template: TEAMMATE_MEMORY_PATH_TEMPLATE,
    default_visibility: namespace.visibility_default,
    global_access: previous?.global_access ?? ('write' as const),
  };
}

async function uniqueTeammateNamespaceSlug(
  namespaces: KnowledgeNamespaceRepository,
  branchId: BranchID
): Promise<string> {
  const base = `teammate-${shortId(branchId)}`;
  let slug = base;
  for (let suffix = 2; await namespaces.findBySlug(slug); suffix += 1) {
    slug = `${base}-${suffix}`;
  }
  return slug;
}

export async function ensureTeammateKnowledgeNamespace(
  db: TenantScopeAwareDatabase,
  branchId: BranchID,
  userId?: UserID | null
): Promise<{ namespace: KnowledgeNamespace; branch: Branch }> {
  const branches = new BranchRepository(db);
  const namespaces = new KnowledgeNamespaceRepository(db);
  const branch = await branches.findById(branchId);
  if (!branch) throw new Error(`Branch not found: ${branchId}`);
  if (!isTeammate(branch)) throw new Error('Branch is not a teammate');

  const teammate = getTeammateConfig(branch);
  const configuredNamespaceId = teammate?.kb?.primary_namespace_id;
  const configuredNamespace = configuredNamespaceId
    ? await namespaces.findById(configuredNamespaceId)
    : null;

  if (configuredNamespace && !configuredNamespace.archived) {
    return { namespace: configuredNamespace, branch };
  }

  const existing = (await namespaces.findAll({ branch_id: branch.branch_id, kind: 'branch' })).find(
    (namespace) => !namespace.archived && isPrimaryTeammateNamespace(namespace, branch.branch_id)
  );

  const createdBy = (userId ?? branch.created_by ?? null) as UserID | null;
  const namespace =
    existing ??
    (
      await namespaces.createWithAcl(
        {
          slug: await uniqueTeammateNamespaceSlug(namespaces, branch.branch_id),
          display_name: `${teammate?.displayName?.trim() || branch.name} Memory`,
          kind: 'branch',
          branch_id: branch.branch_id,
          repo_id: branch.repo_id,
          owner_user_id: createdBy,
          created_by: createdBy,
          visibility_default: 'public',
          others_can: 'write',
          metadata: teammateNamespaceMetadata(branch.branch_id),
        },
        createdBy
          ? [
              {
                subject_type: 'user',
                subject_id: createdBy,
                permission: 'own',
                created_by: createdBy,
              },
            ]
          : []
      )
    ).namespace;

  const updatedBranch = await branches.update(branch.branch_id, {
    custom_context: {
      teammate: {
        ...teammate,
        kb: {
          ...(teammate?.kb?.grants ? { grants: teammate.kb.grants } : {}),
          ...teammateKbPatch(namespace, teammate?.kb),
        },
      },
    },
  });

  return { namespace, branch: updatedBranch };
}
