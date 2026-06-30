import {
  BranchRepository,
  KnowledgeNamespaceRepository,
  shortId,
  type TenantScopeAwareDatabase,
} from '@agor/core/db';
import type {
  AssistantKnowledgeConfig,
  Branch,
  BranchID,
  KnowledgeNamespace,
  UserID,
} from '@agor/core/types';
import { getAssistantConfig, isAssistant } from '@agor/core/types';

export const ASSISTANT_MEMORY_PATH_TEMPLATE = 'memory/{{YYYY-MM-DD}}.md' as const;
export const ASSISTANT_NAMESPACE_MISSING_MESSAGE = 'namespace for this agent is not set up';

function assistantNamespaceMetadata(branchId: BranchID) {
  return {
    assistant: {
      primary: true,
      branch_id: branchId,
      memory_path_template: ASSISTANT_MEMORY_PATH_TEMPLATE,
      docs_root: 'docs/',
      scratchpad_root: 'scratchpad/',
      skills_root: 'skills/',
    },
  };
}

function isPrimaryAssistantNamespace(namespace: KnowledgeNamespace, branchId: BranchID): boolean {
  const assistant = namespace.metadata?.assistant;
  return (
    namespace.branch_id === branchId &&
    assistant !== null &&
    typeof assistant === 'object' &&
    (assistant as Record<string, unknown>).primary === true
  );
}

function assistantKbPatch(namespace: KnowledgeNamespace, previous?: AssistantKnowledgeConfig) {
  return {
    primary_namespace_id: namespace.namespace_id,
    primary_namespace_slug: namespace.slug,
    memory_path_template: ASSISTANT_MEMORY_PATH_TEMPLATE,
    default_visibility: namespace.visibility_default,
    global_access: previous?.global_access ?? ('write' as const),
  };
}

async function uniqueAssistantNamespaceSlug(
  namespaces: KnowledgeNamespaceRepository,
  branchId: BranchID
): Promise<string> {
  const base = `assistant-${shortId(branchId)}`;
  let slug = base;
  for (let suffix = 2; await namespaces.findBySlug(slug); suffix += 1) {
    slug = `${base}-${suffix}`;
  }
  return slug;
}

export async function ensureAssistantKnowledgeNamespace(
  db: TenantScopeAwareDatabase,
  branchId: BranchID,
  userId?: UserID | null
): Promise<{ namespace: KnowledgeNamespace; branch: Branch }> {
  const branches = new BranchRepository(db);
  const namespaces = new KnowledgeNamespaceRepository(db);
  const branch = await branches.findById(branchId);
  if (!branch) throw new Error(`Branch not found: ${branchId}`);
  if (!isAssistant(branch)) throw new Error('Branch is not an assistant');

  const assistant = getAssistantConfig(branch);
  const configuredNamespaceId = assistant?.kb?.primary_namespace_id;
  const configuredNamespace = configuredNamespaceId
    ? await namespaces.findById(configuredNamespaceId)
    : null;

  if (configuredNamespace && !configuredNamespace.archived) {
    return { namespace: configuredNamespace, branch };
  }

  const existing = (await namespaces.findAll({ branch_id: branch.branch_id, kind: 'branch' })).find(
    (namespace) => !namespace.archived && isPrimaryAssistantNamespace(namespace, branch.branch_id)
  );

  const createdBy = (userId ?? branch.created_by ?? null) as UserID | null;
  const namespace =
    existing ??
    (
      await namespaces.createWithAcl(
        {
          slug: await uniqueAssistantNamespaceSlug(namespaces, branch.branch_id),
          display_name: `${assistant?.displayName?.trim() || branch.name} Memory`,
          kind: 'branch',
          branch_id: branch.branch_id,
          repo_id: branch.repo_id,
          owner_user_id: createdBy,
          created_by: createdBy,
          visibility_default: 'public',
          others_can: 'write',
          metadata: assistantNamespaceMetadata(branch.branch_id),
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
      assistant: {
        ...assistant,
        kb: {
          ...(assistant?.kb?.grants ? { grants: assistant.kb.grants } : {}),
          ...assistantKbPatch(namespace, assistant?.kb),
        },
      },
    },
  });

  return { namespace, branch: updatedBranch };
}
