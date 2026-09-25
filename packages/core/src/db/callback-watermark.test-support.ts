import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/** The unchanged main prefix plus the exact reconciliation shipped by 7475feacb. */
export async function withPreviousCallbackJournal(
  dialect: 'sqlite' | 'postgres',
  migrate: (migrationsFolder: string) => Promise<void>
): Promise<void> {
  const folder = await mkdtemp(join(tmpdir(), 'agor-callback-7475feacb-'));
  try {
    await cp(new URL(`../../drizzle/${dialect}/`, import.meta.url), folder, { recursive: true });
    const journalPath = join(folder, 'meta', '_journal.json');
    const journal = JSON.parse(await readFile(journalPath, 'utf8')) as {
      entries: Array<{
        idx: number;
        version: string;
        when: number;
        tag: string;
        breakpoints: boolean;
      }>;
    };
    journal.entries = journal.entries.filter(({ idx }) => idx <= 113);
    journal.entries.push({
      idx: 114,
      version: dialect === 'sqlite' ? '6' : '7',
      when: 1790129000214,
      tag: '0115_callback_ownership_reconciliation',
      breakpoints: true,
    });
    await writeFile(journalPath, JSON.stringify(journal));
    await cp(
      new URL(
        `test-fixtures/7475feacb/${dialect}/0115_callback_ownership_reconciliation.sql`,
        import.meta.url
      ),
      join(folder, '0115_callback_ownership_reconciliation.sql')
    );
    await migrate(folder);
  } finally {
    await rm(folder, { recursive: true, force: true });
  }
}
