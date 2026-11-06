import { cp, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { generateId } from '../lib/ids';
import type { KnowledgeNamespace } from '../types/knowledge';
import type { Database } from './client';
import { KnowledgeNamespaceRepository } from './repositories/knowledge';
import { UsersRepository } from './repositories/users';

const MIGRATION = {
  sqlite: '0119_kb_namespace_others_can_tighten',
  postgres: '0120_kb_namespace_others_can_tighten',
} as const;

/** Copy the migration folder truncated to just before the others_can normalization. */
export async function beforeKbNamespaceOthersCanMigration(dialect: 'sqlite' | 'postgres') {
  const folder = await mkdtemp(join(tmpdir(), 'agor-kb-others-can-'));
  await cp(new URL(`../../drizzle/${dialect}/`, import.meta.url), folder, { recursive: true });
  const path = join(folder, 'meta/_journal.json');
  const journal = JSON.parse(await readFile(path, 'utf8')) as {
    entries: Array<{ idx: number; tag: string }>;
  };
  const next = journal.entries.find(({ tag }) => tag === MIGRATION[dialect]);
  if (!next) throw new Error(`Missing ${MIGRATION[dialect]} in the ${dialect} journal`);
  journal.entries = journal.entries.filter(({ idx }) => idx < next.idx);
  await writeFile(path, JSON.stringify(journal));
  return folder;
}

type Row = Pick<KnowledgeNamespace, 'kind' | 'visibility_default' | 'others_can'> & {
  owned: boolean;
};

/** [stored before, expected after] for every branch of the normalization. */
export const KB_NAMESPACE_OTHERS_CAN_CASES: Array<[Row, KnowledgeNamespace['others_can']]> = [
  [{ kind: 'global', visibility_default: 'public', others_can: 'write', owned: true }, 'read'],
  [{ kind: 'team', visibility_default: 'public', others_can: 'write', owned: true }, 'read'],
  [{ kind: 'user', visibility_default: 'private', others_can: 'write', owned: true }, 'none'],
  [{ kind: 'branch', visibility_default: 'public', others_can: 'write', owned: false }, 'read'],
  [{ kind: 'user', visibility_default: 'public', others_can: 'write', owned: false }, 'read'],
  [{ kind: 'global', visibility_default: 'private', others_can: 'write', owned: false }, 'none'],
  [{ kind: 'global', visibility_default: 'public', others_can: 'write', owned: false }, 'write'],
  [{ kind: 'team', visibility_default: 'public', others_can: 'write', owned: false }, 'write'],
  [{ kind: 'user', visibility_default: 'public', others_can: 'none', owned: true }, 'none'],
  [{ kind: 'branch', visibility_default: 'private', others_can: 'read', owned: true }, 'read'],
];

export async function seedKbNamespaceOthersCanCases(db: Database, prefix: string) {
  const owner = await new UsersRepository(db).create({
    email: `${prefix}-${generateId()}@example.invalid`,
  });
  const namespaces = new KnowledgeNamespaceRepository(db);
  const ids: string[] = [];
  for (const [index, [{ owned, ...row }]] of KB_NAMESPACE_OTHERS_CAN_CASES.entries()) {
    const namespace = await namespaces.create({
      slug: `${prefix}-${index}`,
      ...row,
      owner_user_id: owned ? owner.user_id : null,
    });
    ids.push(namespace.namespace_id);
  }
  return ids;
}

export async function readKbNamespaceOthersCan(db: Database, ids: string[]) {
  const namespaces = new KnowledgeNamespaceRepository(db);
  return Promise.all(ids.map(async (id) => (await namespaces.findById(id))?.others_can));
}
