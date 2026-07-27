import { and, eq } from 'drizzle-orm';
import type {
  KnowledgeSemanticPolicy,
  KnowledgeSemanticSettingsPatch,
  KnowledgeSemanticSettingsPublic,
  StoredKnowledgeSemanticPolicy,
  UserID,
} from '../../types';
import {
  assertValidKnowledgeSemanticPolicy,
  DEFAULT_KNOWLEDGE_SEMANTIC_POLICY,
  KNOWLEDGE_EMBEDDING_PROVIDERS,
} from '../../types';
import type { Database, TenantScopedDatabase } from '../client';
import {
  isPostgresDatabase,
  isSQLiteDatabase,
  lockRowForUpdate,
  runDatabaseTransaction,
} from '../database-wrapper';
import { appVariables } from '../schema';
import { getCurrentTenantDatabase } from '../tenant-scope';
import { AppVariableRepository } from './app-variables';

export const KNOWLEDGE_SEMANTIC_SETTINGS_NAMESPACE = 'knowledge.semantic_search';
export const KNOWLEDGE_SEMANTIC_SETTINGS_KEY = 'policy';
export const KNOWLEDGE_EMBEDDINGS_NAMESPACE = 'knowledge.embeddings';
export const KNOWLEDGE_EMBEDDINGS_API_KEY = 'api_key';

export interface KnowledgeSemanticSettingsMutation {
  previous: KnowledgeSemanticSettingsPublic;
  saved: KnowledgeSemanticSettingsPublic;
}

const POLICY_FIELDS = [
  'enabled',
  'provider',
  'model',
  'dimensions',
  'chunking',
  'indexing',
] as const;
const CHUNKING_FIELDS = ['target_tokens', 'max_tokens', 'overlap_tokens', 'min_tokens'] as const;
const INDEXING_FIELDS = ['paused', 'batch_size'] as const;

function assertRecord(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`Invalid stored ${label}`);
  }
  return value as Record<string, unknown>;
}

function assertOnlyFields(
  value: Record<string, unknown>,
  fields: readonly string[],
  label: string
): void {
  const unknown = Object.keys(value).filter((key) => !fields.includes(key));
  if (unknown.length > 0) throw new Error(`Invalid stored ${label} field: ${unknown[0]}`);
}

function parseInteger(value: unknown, label: string): number {
  if (!Number.isInteger(value)) throw new Error(`Invalid stored ${label}`);
  return value as number;
}

export function parseStoredKnowledgeSemanticPolicy(value: string): StoredKnowledgeSemanticPolicy {
  const input = assertRecord(JSON.parse(value) as unknown, 'Knowledge semantic-search policy');
  assertOnlyFields(input, POLICY_FIELDS, 'Knowledge semantic-search policy');

  if (input.enabled !== undefined && input.enabled !== true) {
    throw new Error('Invalid stored Knowledge semantic-search enabled value');
  }
  if (
    input.provider !== undefined &&
    !(KNOWLEDGE_EMBEDDING_PROVIDERS as readonly unknown[]).includes(input.provider)
  ) {
    throw new Error('Invalid stored Knowledge semantic-search provider');
  }
  if (
    input.model !== undefined &&
    (typeof input.model !== 'string' || input.model.trim().length === 0)
  ) {
    throw new Error('Invalid stored Knowledge semantic-search model');
  }

  const chunking =
    input.chunking === undefined
      ? undefined
      : assertRecord(input.chunking, 'Knowledge semantic-search chunking');
  if (chunking) assertOnlyFields(chunking, CHUNKING_FIELDS, 'Knowledge semantic-search chunking');
  const indexing =
    input.indexing === undefined
      ? undefined
      : assertRecord(input.indexing, 'Knowledge semantic-search indexing');
  if (indexing) assertOnlyFields(indexing, INDEXING_FIELDS, 'Knowledge semantic-search indexing');
  if (indexing?.paused !== undefined && typeof indexing.paused !== 'boolean') {
    throw new Error('Invalid stored Knowledge semantic-search indexing.paused');
  }

  return {
    ...(input.enabled === true ? { enabled: true as const } : {}),
    ...(input.provider !== undefined
      ? { provider: input.provider as StoredKnowledgeSemanticPolicy['provider'] }
      : {}),
    ...(input.model !== undefined ? { model: input.model.trim() } : {}),
    ...(input.dimensions !== undefined
      ? {
          dimensions: parseInteger(
            input.dimensions,
            'Knowledge semantic-search embedding dimensions'
          ),
        }
      : {}),
    ...(chunking
      ? {
          chunking: Object.fromEntries(
            CHUNKING_FIELDS.filter((field) => chunking[field] !== undefined).map((field) => [
              field,
              parseInteger(chunking[field], `Knowledge semantic-search chunking.${field}`),
            ])
          ),
        }
      : {}),
    ...(indexing
      ? {
          indexing: {
            ...(indexing.paused !== undefined ? { paused: indexing.paused as boolean } : {}),
            ...Object.fromEntries(
              INDEXING_FIELDS.filter(
                (field) => field !== 'paused' && indexing[field] !== undefined
              ).map((field) => [
                field,
                parseInteger(indexing[field], `Knowledge semantic-search indexing.${field}`),
              ])
            ),
          },
        }
      : {}),
  };
}

export function resolveKnowledgeSemanticPolicy(
  stored: StoredKnowledgeSemanticPolicy = {}
): KnowledgeSemanticPolicy {
  return {
    enabled: stored.enabled === true,
    provider: stored.provider ?? DEFAULT_KNOWLEDGE_SEMANTIC_POLICY.provider,
    model: stored.model ?? DEFAULT_KNOWLEDGE_SEMANTIC_POLICY.model,
    dimensions: stored.dimensions ?? DEFAULT_KNOWLEDGE_SEMANTIC_POLICY.dimensions,
    chunking: {
      ...DEFAULT_KNOWLEDGE_SEMANTIC_POLICY.chunking,
      ...(stored.chunking ?? {}),
    },
    indexing: {
      ...DEFAULT_KNOWLEDGE_SEMANTIC_POLICY.indexing,
      ...(stored.indexing ?? {}),
    },
  };
}

function storeNonDefaultPolicy(policy: KnowledgeSemanticPolicy): StoredKnowledgeSemanticPolicy {
  const chunking = Object.fromEntries(
    CHUNKING_FIELDS.filter(
      (field) => policy.chunking[field] !== DEFAULT_KNOWLEDGE_SEMANTIC_POLICY.chunking[field]
    ).map((field) => [field, policy.chunking[field]])
  );
  const indexing = Object.fromEntries(
    INDEXING_FIELDS.filter(
      (field) => policy.indexing[field] !== DEFAULT_KNOWLEDGE_SEMANTIC_POLICY.indexing[field]
    ).map((field) => [field, policy.indexing[field]])
  );
  return {
    ...(policy.enabled ? { enabled: true as const } : {}),
    ...(policy.provider !== DEFAULT_KNOWLEDGE_SEMANTIC_POLICY.provider
      ? { provider: policy.provider }
      : {}),
    ...(policy.model !== DEFAULT_KNOWLEDGE_SEMANTIC_POLICY.model ? { model: policy.model } : {}),
    ...(policy.dimensions !== DEFAULT_KNOWLEDGE_SEMANTIC_POLICY.dimensions
      ? { dimensions: policy.dimensions }
      : {}),
    ...(Object.keys(chunking).length > 0 ? { chunking } : {}),
    ...(Object.keys(indexing).length > 0 ? { indexing } : {}),
  };
}

export function applyKnowledgeSemanticPolicyPatch(
  stored: StoredKnowledgeSemanticPolicy,
  patch: KnowledgeSemanticSettingsPatch
): StoredKnowledgeSemanticPolicy {
  const current = resolveKnowledgeSemanticPolicy(stored);
  const applyNestedPatch = <T extends object>(
    currentValue: T,
    defaultValue: T,
    nestedPatch: { [K in keyof T]?: T[K] | null } | null | undefined,
    fields: readonly (keyof T)[]
  ): T => {
    if (nestedPatch === null) return { ...defaultValue };
    const next = { ...currentValue };
    if (!nestedPatch) return next;
    for (const field of fields) {
      const value = nestedPatch[field];
      if (value !== undefined) next[field] = value === null ? defaultValue[field] : value;
    }
    return next;
  };
  const chunking = applyNestedPatch(
    current.chunking,
    DEFAULT_KNOWLEDGE_SEMANTIC_POLICY.chunking,
    patch.chunking,
    CHUNKING_FIELDS
  );
  const indexing = applyNestedPatch(
    current.indexing,
    DEFAULT_KNOWLEDGE_SEMANTIC_POLICY.indexing,
    patch.indexing,
    INDEXING_FIELDS
  );

  return storeNonDefaultPolicy({
    enabled: patch.enabled ?? current.enabled,
    provider:
      patch.provider === null
        ? DEFAULT_KNOWLEDGE_SEMANTIC_POLICY.provider
        : (patch.provider ?? current.provider),
    model:
      patch.model === null
        ? DEFAULT_KNOWLEDGE_SEMANTIC_POLICY.model
        : (patch.model?.trim() ?? current.model),
    dimensions:
      patch.dimensions === null
        ? DEFAULT_KNOWLEDGE_SEMANTIC_POLICY.dimensions
        : (patch.dimensions ?? current.dimensions),
    chunking,
    indexing,
  });
}

function normalizeApiKey(value: string | null): string | null {
  const trimmed = value?.trim() ?? '';
  return trimmed.length > 0 ? trimmed : null;
}

/**
 * Typed tenant-owned Knowledge semantic-search policy and encrypted provider
 * credential. Tenant identity comes from the ambient database scope.
 */
export class KnowledgeSemanticSettingsRepository {
  private variables: AppVariableRepository;

  constructor(private db: Database) {
    this.variables = new AppVariableRepository(db);
  }

  private async findStoredWith(
    variables: AppVariableRepository
  ): Promise<StoredKnowledgeSemanticPolicy> {
    const value = await variables.getPlain(
      KNOWLEDGE_SEMANTIC_SETTINGS_NAMESPACE,
      KNOWLEDGE_SEMANTIC_SETTINGS_KEY
    );
    return value ? parseStoredKnowledgeSemanticPolicy(value) : {};
  }

  async findPolicy(): Promise<KnowledgeSemanticPolicy> {
    const policy = resolveKnowledgeSemanticPolicy(await this.findStoredWith(this.variables));
    assertValidKnowledgeSemanticPolicy(policy);
    return policy;
  }

  async hasApiKey(): Promise<boolean> {
    const value = await this.variables.find(
      KNOWLEDGE_EMBEDDINGS_NAMESPACE,
      KNOWLEDGE_EMBEDDINGS_API_KEY
    );
    return Boolean(value?.is_encrypted && value.value_encrypted);
  }

  async getApiKey(): Promise<string | null> {
    return this.variables.getPlain(KNOWLEDGE_EMBEDDINGS_NAMESPACE, KNOWLEDGE_EMBEDDINGS_API_KEY);
  }

  async find(): Promise<KnowledgeSemanticSettingsPublic> {
    const policy = await this.findPolicy();
    const apiKeyConfigured = await this.hasApiKey();
    return { ...policy, api_key_configured: apiKeyConfigured };
  }

  /**
   * Acquire the stable tenant aggregate lock used by every operation that
   * materializes state derived from semantic-search policy. Callers must pass
   * their active transaction and retain it for all dependent writes.
   */
  async lockAggregateForUpdate(
    txDb: TenantScopedDatabase,
    updatedBy?: UserID | null
  ): Promise<KnowledgeSemanticSettingsPublic> {
    const variables = new AppVariableRepository(txDb);
    await variables.setIfAbsent({
      namespace: KNOWLEDGE_SEMANTIC_SETTINGS_NAMESPACE,
      key: KNOWLEDGE_SEMANTIC_SETTINGS_KEY,
      value: '{}',
      content_type: 'application/json',
      updated_by: updatedBy ?? null,
    });
    await lockRowForUpdate(
      txDb,
      this.db,
      appVariables,
      and(
        eq(appVariables.namespace, KNOWLEDGE_SEMANTIC_SETTINGS_NAMESPACE),
        eq(appVariables.key, KNOWLEDGE_SEMANTIC_SETTINGS_KEY)
      )!
    );

    const policy = resolveKnowledgeSemanticPolicy(await this.findStoredWith(variables));
    assertValidKnowledgeSemanticPolicy(policy);
    const apiKey = await variables.find(
      KNOWLEDGE_EMBEDDINGS_NAMESPACE,
      KNOWLEDGE_EMBEDDINGS_API_KEY
    );
    return {
      ...policy,
      api_key_configured: Boolean(apiKey?.is_encrypted && apiKey.value_encrypted),
    };
  }

  /**
   * Apply a patch inside a caller-owned transaction. This is used when the
   * settings write and dependent Knowledge-unit updates must commit together.
   */
  async patchInTransaction(
    txDb: TenantScopedDatabase,
    patch: KnowledgeSemanticSettingsPatch,
    updatedBy?: UserID | null,
    validate?: (policy: KnowledgeSemanticPolicy) => void
  ): Promise<KnowledgeSemanticSettingsMutation> {
    const hasPolicyPatch = POLICY_FIELDS.some((field) => Object.hasOwn(patch, field));
    const variables = new AppVariableRepository(txDb);

    // The policy row is the stable aggregate lock for both policy and
    // credential mutations. Every patch takes it before reading the combined
    // state so sparse concurrent patches cannot derive side effects from
    // different snapshots.
    const previous = await this.lockAggregateForUpdate(txDb, updatedBy);
    const currentStored = await this.findStoredWith(variables);
    let policy: KnowledgeSemanticPolicy = previous;
    if (hasPolicyPatch) {
      const next = applyKnowledgeSemanticPolicyPatch(currentStored, patch);
      policy = resolveKnowledgeSemanticPolicy(next);
      assertValidKnowledgeSemanticPolicy(policy);
      validate?.(policy);
      // Keep the default-valued row as the aggregate mutation lock. Reads do
      // not materialize it; the first write does.
      await variables.set({
        namespace: KNOWLEDGE_SEMANTIC_SETTINGS_NAMESPACE,
        key: KNOWLEDGE_SEMANTIC_SETTINGS_KEY,
        value: JSON.stringify(next),
        content_type: 'application/json',
        updated_by: updatedBy ?? null,
      });
    } else {
      validate?.(policy);
    }

    if (patch.api_key !== undefined) {
      await variables.setIfAbsent({
        namespace: KNOWLEDGE_EMBEDDINGS_NAMESPACE,
        key: KNOWLEDGE_EMBEDDINGS_API_KEY,
        value: null,
        encrypted: true,
        updated_by: updatedBy ?? null,
      });
      await lockRowForUpdate(
        txDb,
        this.db,
        appVariables,
        and(
          eq(appVariables.namespace, KNOWLEDGE_EMBEDDINGS_NAMESPACE),
          eq(appVariables.key, KNOWLEDGE_EMBEDDINGS_API_KEY)
        )!
      );
      await variables.setEncrypted(
        KNOWLEDGE_EMBEDDINGS_NAMESPACE,
        KNOWLEDGE_EMBEDDINGS_API_KEY,
        normalizeApiKey(patch.api_key),
        updatedBy ?? null
      );
    }

    const apiKey = await variables.find(
      KNOWLEDGE_EMBEDDINGS_NAMESPACE,
      KNOWLEDGE_EMBEDDINGS_API_KEY
    );
    return {
      previous,
      saved: {
        ...policy,
        api_key_configured: Boolean(apiKey?.is_encrypted && apiKey.value_encrypted),
      },
    };
  }

  async patch(
    patch: KnowledgeSemanticSettingsPatch,
    updatedBy?: UserID | null,
    validate?: (policy: KnowledgeSemanticPolicy) => void
  ): Promise<KnowledgeSemanticSettingsPublic> {
    const apply = async (txDb: Database) =>
      (await this.patchInTransaction(txDb as TenantScopedDatabase, patch, updatedBy, validate))
        .saved;

    const ambientDb = getCurrentTenantDatabase();
    if (ambientDb && isPostgresDatabase(ambientDb)) return apply(ambientDb);
    if (isSQLiteDatabase(this.db)) {
      for (let attempt = 0; ; attempt++) {
        try {
          return await runDatabaseTransaction(this.db, apply, { sqliteImmediate: true });
        } catch (error) {
          if ((error as { code?: string }).code !== 'SQLITE_BUSY' || attempt >= 9) throw error;
          await new Promise((resolve) => setTimeout(resolve, 5 * (attempt + 1)));
        }
      }
    }
    return runDatabaseTransaction(this.db, apply);
  }
}
