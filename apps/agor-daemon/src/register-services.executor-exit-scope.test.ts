import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

describe('executor exit termination tenant scope', () => {
  it('gives launcher-exit durable operations fresh tenant database units', () => {
    const source = readFileSync(new URL('./register-services.ts', import.meta.url), 'utf8');
    const executor = source.slice(
      source.indexOf('const runInFreshTerminationTenantWriteDatabase'),
      source.indexOf(
        'if (openCodeLaunch)',
        source.indexOf('const runInFreshTerminationTenantWriteDatabase')
      )
    );

    expect(executor).toContain(
      'runInFreshTenantWriteDatabase: runInFreshTerminationTenantWriteDatabase'
    );
    expect(executor).toMatch(
      /runInFreshTerminationTenantWriteDatabase\(\(\) =>\s+\(\s+app\.service\('tasks'\)/
    );
  });

  it('terminates a refused templated launch as launch_refused with verified absence', () => {
    const source = readFileSync(new URL('./register-services.ts', import.meta.url), 'utf8');
    const onExit = source.slice(
      source.indexOf('onExit: async (code, spawnContext) => {'),
      source.indexOf('if (executorLaunch?.requiresLocalContainment)')
    );

    expect(onExit).toContain("launchRefused = disposition === 'refused';");
    expect(onExit).toContain("if (disposition !== 'authoritative' && !launchRefused)");
    expect(onExit).toContain('executorExitTermination(code, launchRefused)');
    expect(onExit).toMatch(/cause,\s+errorMessage,/);
    expect(onExit).toContain('absenceVerified: templatedLauncherAbsenceVerified');
    expect(onExit).toContain('reason: cause');
    // A refusal drops only the status fence, so it settles a Stop that came
    // first; a connected executor still wins the race.
    expect(onExit).toMatch(
      /\.\.\.\(launchRefused \? \{\} : \{ expectedStatus: TaskStatus\.DISPATCHING \}\),\s+requireExecutorDisconnected: true/
    );
  });
});
