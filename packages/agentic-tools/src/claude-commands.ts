// Compatibility fallback for inventories saved before terminal-command metadata
// was persisted (#2938). These are command IDs, not display labels.
const LEGACY_CLAUDE_TERMINAL_COMMANDS = [
  'usage',
  'login',
  'config',
  'terminal-setup',
  'doctor',
  'vim',
];

const commandId = (command: string) => command.replace(/^\//, '').toLowerCase();

/**
 * Discovery only, not a prompt admission policy. The pinned Claude SDK supplies
 * a headless-supported slash_commands inventory and terminal_slash_commands for
 * commands whose UX still belongs to the terminal. Prefer that runtime metadata
 * over a built-in allowlist: it preserves custom/MCP commands and newly supported
 * built-ins (notably usage and config in SDK 0.3.288).
 *
 * undefined means an old saved inventory; [] means the current SDK reported no
 * terminal commands. Call only for Claude SDK sessions, never standalone CLIs.
 */
export function filterClaudeSdkCommands(
  commands: string[],
  terminalCommands: readonly string[] = LEGACY_CLAUDE_TERMINAL_COMMANDS
): string[] {
  const terminalIds = new Set(terminalCommands.map(commandId));
  return commands.filter((command) => !terminalIds.has(commandId(command)));
}
