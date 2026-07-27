import { beforeAll, describe, expect } from 'vitest';
import { dbTest } from '../test-helpers';
import { AppVariableRepository } from './app-variables';
import {
  KNOWLEDGE_EMBEDDINGS_API_KEY,
  KNOWLEDGE_EMBEDDINGS_NAMESPACE,
  KNOWLEDGE_SEMANTIC_SETTINGS_KEY,
  KNOWLEDGE_SEMANTIC_SETTINGS_NAMESPACE,
  KnowledgeSemanticSettingsRepository,
} from './knowledge-semantic-settings';

beforeAll(() => {
  process.env.AGOR_MASTER_SECRET ||= 'knowledge-semantic-settings-test-secret';
});

describe('KnowledgeSemanticSettingsRepository', () => {
  dbTest(
    'resolves an absent tenant policy to safe defaults without materializing state',
    async ({ db }) => {
      const repository = new KnowledgeSemanticSettingsRepository(db);
      await expect(repository.find()).resolves.toEqual({
        enabled: false,
        provider: 'openai',
        model: 'text-embedding-3-small',
        dimensions: 1536,
        api_key_configured: false,
        chunking: {
          target_tokens: 850,
          max_tokens: 1200,
          overlap_tokens: 100,
          min_tokens: 80,
        },
        indexing: { paused: false, batch_size: 32 },
      });

      await expect(
        new AppVariableRepository(db).find(
          KNOWLEDGE_SEMANTIC_SETTINGS_NAMESPACE,
          KNOWLEDGE_SEMANTIC_SETTINGS_KEY
        )
      ).resolves.toBeNull();
    }
  );

  dbTest('stores typed tenant policy separately from the encrypted API key', async ({ db }) => {
    const repository = new KnowledgeSemanticSettingsRepository(db);
    await repository.patch({
      enabled: true,
      model: 'text-embedding-3-large',
      api_key: '  workspace-secret  ',
      chunking: { target_tokens: 640 },
    });

    await expect(repository.find()).resolves.toMatchObject({
      enabled: true,
      model: 'text-embedding-3-large',
      api_key_configured: true,
      chunking: { target_tokens: 640, max_tokens: 1200 },
    });
    await expect(repository.getApiKey()).resolves.toBe('workspace-secret');

    const variables = new AppVariableRepository(db);
    const policy = await variables.find(
      KNOWLEDGE_SEMANTIC_SETTINGS_NAMESPACE,
      KNOWLEDGE_SEMANTIC_SETTINGS_KEY
    );
    expect(policy).toMatchObject({
      is_encrypted: false,
      content_type: 'application/json',
    });
    expect(JSON.parse(policy?.value_text ?? '')).toEqual({
      enabled: true,
      model: 'text-embedding-3-large',
      chunking: { target_tokens: 640 },
    });

    const secret = await variables.find(
      KNOWLEDGE_EMBEDDINGS_NAMESPACE,
      KNOWLEDGE_EMBEDDINGS_API_KEY
    );
    expect(secret?.value_text).toBeNull();
    expect(secret?.value_encrypted).toBeTruthy();
    expect(secret?.value_encrypted).not.toContain('workspace-secret');
  });

  dbTest('distinguishes omitted fields from explicit null resets', async ({ db }) => {
    const repository = new KnowledgeSemanticSettingsRepository(db);
    await repository.patch({
      enabled: true,
      model: 'text-embedding-3-large',
      api_key: 'workspace-secret',
      chunking: { target_tokens: 640 },
    });
    await repository.patch({});
    await expect(repository.find()).resolves.toMatchObject({
      enabled: true,
      model: 'text-embedding-3-large',
      api_key_configured: true,
      chunking: { target_tokens: 640 },
    });

    await repository.patch({
      enabled: false,
      model: null,
      api_key: null,
      chunking: { target_tokens: null },
    });
    await expect(repository.find()).resolves.toMatchObject({
      enabled: false,
      model: 'text-embedding-3-small',
      api_key_configured: false,
      chunking: { target_tokens: 850 },
    });
    await expect(
      new AppVariableRepository(db).find(
        KNOWLEDGE_SEMANTIC_SETTINGS_NAMESPACE,
        KNOWLEDGE_SEMANTIC_SETTINGS_KEY
      )
    ).resolves.toMatchObject({ value_text: '{}' });
  });

  dbTest('fails closed on malformed stored policy JSON', async ({ db }) => {
    const variables = new AppVariableRepository(db);
    await variables.set({
      namespace: KNOWLEDGE_SEMANTIC_SETTINGS_NAMESPACE,
      key: KNOWLEDGE_SEMANTIC_SETTINGS_KEY,
      value: JSON.stringify({ enabled: 'yes' }),
      content_type: 'application/json',
    });

    await expect(new KnowledgeSemanticSettingsRepository(db).findPolicy()).rejects.toThrow(
      'Invalid stored Knowledge semantic-search enabled value'
    );

    await variables.set({
      namespace: KNOWLEDGE_SEMANTIC_SETTINGS_NAMESPACE,
      key: KNOWLEDGE_SEMANTIC_SETTINGS_KEY,
      value: JSON.stringify({ chunking: { target_tokens: 1300, max_tokens: 1200 } }),
      content_type: 'application/json',
    });
    await expect(new KnowledgeSemanticSettingsRepository(db).findPolicy()).rejects.toThrow(
      'Knowledge chunking target_tokens must be less than or equal to max_tokens'
    );
  });

  dbTest('enforces portable policy invariants for direct repository callers', async ({ db }) => {
    const repository = new KnowledgeSemanticSettingsRepository(db);

    await expect(
      repository.patch({
        chunking: { target_tokens: 1300, max_tokens: 1200 },
      })
    ).rejects.toThrow('Knowledge chunking target_tokens must be less than or equal to max_tokens');

    await expect(repository.find()).resolves.toMatchObject({
      enabled: false,
      chunking: { target_tokens: 850, max_tokens: 1200 },
    });
    await expect(
      new AppVariableRepository(db).find(
        KNOWLEDGE_SEMANTIC_SETTINGS_NAMESPACE,
        KNOWLEDGE_SEMANTIC_SETTINGS_KEY
      )
    ).resolves.toBeNull();
  });

  dbTest('serializes concurrent first writes and partial policy patches', async ({ db }) => {
    const repository = new KnowledgeSemanticSettingsRepository(db);

    await Promise.all([
      repository.patch({ api_key: 'workspace-secret-a' }),
      repository.patch({ api_key: 'workspace-secret-b' }),
      repository.patch({ model: 'text-embedding-3-large' }),
      repository.patch({ chunking: { target_tokens: 640 } }),
    ]);

    await expect(repository.find()).resolves.toMatchObject({
      model: 'text-embedding-3-large',
      api_key_configured: true,
      chunking: { target_tokens: 640 },
    });
    await expect(repository.getApiKey()).resolves.toMatch(/^workspace-secret-[ab]$/);

    const variables = new AppVariableRepository(db);
    await expect(
      variables.find(KNOWLEDGE_EMBEDDINGS_NAMESPACE, KNOWLEDGE_EMBEDDINGS_API_KEY)
    ).resolves.toMatchObject({
      is_encrypted: true,
      value_text: null,
    });
  });
});
