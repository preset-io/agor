import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { SDK_ACTIVITY_VERSION_MANIFEST } from '../sdk-watchdog.js';
import { reportCodexActivity } from './codex/sdk-activity.js';

describe('provider-owned SDK activity translation', () => {
  it('maps Codex item lifecycles to an identified operation', () => {
    const callback = vi.fn();

    reportCodexActivity(callback, {
      type: 'item.started',
      item: { id: 'item-1', type: 'command_execution' },
    });
    reportCodexActivity(callback, {
      type: 'item.updated',
      item: { id: 'item-1', type: 'command_execution' },
    });
    reportCodexActivity(callback, {
      type: 'item.completed',
      item: { id: 'item-1', type: 'command_execution' },
    });

    expect(callback.mock.calls).toEqual([
      [{ type: 'operation_started', id: 'item-1', kind: 'command_execution' }],
      [{ type: 'operation_progress', id: 'item-1' }],
      [{ type: 'operation_finished', id: 'item-1' }],
    ]);
  });

  it('surfaces new Codex vocabulary as diagnosis rather than progress', () => {
    const callback = vi.fn();
    reportCodexActivity(callback, { type: 'future.event' });
    expect(callback).toHaveBeenCalledWith({
      type: 'unknown_activity',
      detail: 'future.event',
    });
  });

  it('does not treat reconnect bookkeeping as progress', () => {
    const callback = vi.fn();
    reportCodexActivity(callback, { type: 'error', message: 'Reconnecting... 1 / 5' });
    expect(callback).not.toHaveBeenCalled();
  });
});

describe('SDK activity version manifest', () => {
  it('matches every reviewed resolved dependency version', () => {
    const lockfile = readFileSync(new URL('../../../../pnpm-lock.yaml', import.meta.url), 'utf8');
    expect(Object.keys(SDK_ACTIVITY_VERSION_MANIFEST).sort()).toEqual(
      ['claude-code', 'codex', 'gemini', 'copilot', 'opencode', 'cursor'].sort()
    );
    for (const dependency of Object.values(SDK_ACTIVITY_VERSION_MANIFEST)) {
      expect(lockfile).toContain(`'${dependency}':`);
    }
  });
});
