import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

describe('BTW completion archive wiring', () => {
  const source = readFileSync(join(__dirname, 'tasks.ts'), 'utf8');

  it('uses the branch-local lifecycle operation instead of a generic session patch', () => {
    const start = source.indexOf("if (session.fork_origin === 'btw')");
    const end = source.indexOf('if (!params?.suppressTerminalQueueProcessing)', start);
    const cleanup = source.slice(start, end);

    expect(start).toBeGreaterThan(0);
    expect(end).toBeGreaterThan(start);
    expect(cleanup).toContain(
      'sessionsService.archiveBtwSession(session.session_id, archiveParams)'
    );
    expect(cleanup).not.toContain('sessionsService.patch(');
  });
});
