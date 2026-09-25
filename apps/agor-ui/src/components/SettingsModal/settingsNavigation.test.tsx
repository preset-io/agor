import { describe, expect, it } from 'vitest';
import { SETTINGS_SECTIONS } from '../../hooks/useSettingsRoute';
import { buildSettingsNav, settingsSectionMobileLabel } from './settingsNavigation';

const sections = (groups: ReturnType<typeof buildSettingsNav>) =>
  groups.flatMap((group) => group.rows.map((row) => row.section));

describe('buildSettingsNav', () => {
  it('lists every routable section exactly once for a fully privileged caller', () => {
    const all = sections(buildSettingsNav({ isAdmin: true, canSeeSection: () => true }));
    expect([...all].sort()).toEqual([...SETTINGS_SECTIONS].sort());
  });

  it('drops gated rows and any group left empty', () => {
    const nav = buildSettingsNav({
      isAdmin: false,
      canSeeSection: (section) =>
        !['agentic-tools', 'gateway', 'groups', 'users'].includes(section),
    });
    expect(sections(nav)).not.toContain('workspace-preferences');
    expect(sections(nav)).toContain('mcp');
    expect(nav.map((group) => group.key)).toEqual(['workspace', 'integrations', 'system']);
  });

  it('attaches counts only where provided', () => {
    const nav = buildSettingsNav({
      isAdmin: true,
      canSeeSection: () => true,
      counts: { boards: 3 },
    });
    const rows = nav.flatMap((group) => group.rows);
    expect(rows.find((row) => row.section === 'boards')?.count).toBe(3);
    expect(rows.find((row) => row.section === 'teammates')?.count).toBeUndefined();
  });

  it('keeps the desktop and mobile headings, labels and Beta marker the shells render', () => {
    const nav = buildSettingsNav({ isAdmin: true, canSeeSection: () => true });
    expect(nav.map((group) => [group.key, group.title, group.mobileTitle])).toEqual([
      ['workspace', 'Workspace', undefined],
      ['integrations', 'Integrations', undefined],
      ['admin', 'Admin', 'Members & groups'],
      ['system', 'System', 'About'],
    ]);
    const rows = nav.flatMap((group) => group.rows);
    expect(rows.filter((row) => row.beta).map((row) => row.section)).toEqual(['cards']);
    expect(
      rows.filter((row) => row.mobileLabel).map((row) => [row.section, row.label, row.mobileLabel])
    ).toEqual([
      ['agentic-tools', 'Agentic Tools', 'Agentic tools'],
      ['mcp', 'MCP Servers', 'MCP servers'],
      ['gateway', 'Gateway Channels', 'Gateway channels'],
      ['about', 'About', 'About Agor'],
    ]);
  });
});

describe('settingsSectionMobileLabel', () => {
  it('prefers the mobile label and resolves role-gated sections too', () => {
    expect(settingsSectionMobileLabel('about')).toBe('About Agor');
    expect(settingsSectionMobileLabel('boards')).toBe('Boards');
    expect(settingsSectionMobileLabel('workspace-preferences')).toBe('Preferences');
  });
});
