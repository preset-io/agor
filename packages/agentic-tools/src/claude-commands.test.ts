import { describe, expect, it } from 'vitest';
import { filterClaudeSdkCommands } from './claude-commands.js';

describe('filterClaudeSdkCommands', () => {
  it('hides known CLI-only IDs in legacy inventories, with or without a slash', () => {
    const unsupported = ['usage', 'login', 'config', 'terminal-setup', 'doctor', 'vim'];
    for (const prefix of ['', '/']) {
      expect(filterClaudeSdkCommands(unsupported.map((id) => `${prefix}${id}`))).toEqual([]);
    }
  });

  it('uses runtime metadata rather than freezing the set of supported built-ins', () => {
    const commands = ['compact', 'usage', 'config', '/Doctor', 'new-terminal-command'];
    expect(filterClaudeSdkCommands(commands, ['doctor', '/new-terminal-command'])).toEqual([
      'compact',
      'usage',
      'config',
    ]);
    expect(filterClaudeSdkCommands(commands, [])).toEqual(commands);
  });

  it('preserves custom, plugin and MCP command IDs, order and spelling without mutating input', () => {
    const commands = [
      '/compact',
      'context',
      'clear',
      'usage-report',
      'plugin:doctor',
      'mcp__login',
      'review',
    ];
    expect(filterClaudeSdkCommands(commands)).toEqual(commands);
  });
});
