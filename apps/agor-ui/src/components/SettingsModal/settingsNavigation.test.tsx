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
    expect(nav.map((group) => group.key)).toEqual(['resources', 'cards', 'system']);
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
    expect(nav.map((group) => [group.key, group.title, group.mobileTitle, group.badge])).toEqual([
      ['people', 'People', undefined, undefined],
      ['resources', 'Resources', undefined, undefined],
      ['cards', 'Cards', undefined, 'Beta'],
      ['integrations', 'Integrations', undefined, 'Admin'],
      ['system', 'System', 'About', undefined],
    ]);
    const rows = nav.flatMap((group) => group.rows);
    expect(
      rows.filter((row) => row.mobileLabel).map((row) => [row.section, row.label, row.mobileLabel])
    ).toEqual([
      ['agentic-tools', 'Agentic Tools', 'Agentic tools'],
      ['gateway', 'Gateway Channels', 'Gateway channels'],
      ['about', 'About', 'About Agor'],
    ]);
  });

  it('has no MCP Servers section: MCP lives in the Marketplace', () => {
    const nav = buildSettingsNav({ isAdmin: true, canSeeSection: () => true });
    expect(sections(nav)).not.toContain('mcp' as never);
    expect(nav.flatMap((group) => group.rows).map((row) => row.label)).not.toContain('MCP Servers');
  });
});

describe('settingsSectionMobileLabel', () => {
  it('prefers the mobile label and resolves role-gated sections too', () => {
    expect(settingsSectionMobileLabel('about')).toBe('About Agor');
    expect(settingsSectionMobileLabel('boards')).toBe('Boards');
    expect(settingsSectionMobileLabel('workspace-preferences')).toBe('Preferences');
  });
});
