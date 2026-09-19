// biome-ignore-all lint/plugin/noHardcodedColorLiteral: persisted zone color fixtures
import type { ZoneBoardObject } from '@agor-live/client';
import { describe, expect, it } from 'vitest';
import { applyZoneConfigDraft, createZoneConfigDraft } from './zoneConfigDraft';

const zone: ZoneBoardObject = {
  type: 'zone',
  x: 10,
  y: 20,
  width: 200,
  height: 100,
  label: 'Review',
  locked: true,
  color: '#ff0000',
  borderColor: '#123456',
  backgroundColor: '#abcdef',
  fontSize: 22,
  status: 'Ready',
  zIndex: 42,
  trigger: { behavior: 'always_new', template: 'Old prompt', agent: 'codex' },
};

describe('zone configuration draft merge', () => {
  const initial = createZoneConfigDraft(zone, zone.label);

  it('does not write an untouched draft, even when remote fields changed', () => {
    expect(applyZoneConfigDraft({ ...zone, label: 'Remote' }, initial, initial)).toBeUndefined();
    const empty = { ...zone, trigger: undefined };
    const draft = createZoneConfigDraft(empty, empty.label);
    expect(applyZoneConfigDraft(empty, draft, draft)).toBeUndefined();
  });

  it('preserves remote fields and trigger subfields while applying a prompt edit', () => {
    const latest: ZoneBoardObject = {
      ...zone,
      x: 99,
      width: 300,
      label: 'Remote name',
      locked: false,
      borderColor: '#654321',
      backgroundColor: undefined,
      fontSize: 30,
      status: 'Remote status',
      zIndex: 45,
      trigger: { behavior: 'show_picker', template: 'Remote prompt', agent: 'claude-code' },
    };
    expect(
      applyZoneConfigDraft(latest, initial, { ...initial, triggerTemplate: '  Local prompt  ' })
    ).toEqual({ ...latest, trigger: { ...latest.trigger, template: 'Local prompt' } });
  });

  it('treats explicit empty/default values as edits under full replacement', () => {
    const result = applyZoneConfigDraft(zone, initial, {
      ...initial,
      name: '',
      locked: false,
      borderColor: undefined,
      backgroundColor: undefined,
      fontSize: undefined,
      clearLegacyColor: true,
      triggerTemplate: '   ',
    });
    expect(JSON.parse(JSON.stringify(result))).toEqual({
      type: 'zone',
      x: 10,
      y: 20,
      width: 200,
      height: 100,
      label: '',
      locked: false,
      status: 'Ready',
      zIndex: 42,
    });
  });

  it('preserves a remote trigger removal on appearance-only edits', () => {
    expect(
      applyZoneConfigDraft({ ...zone, trigger: undefined }, initial, {
        ...initial,
        name: 'Renamed',
      })
    ).toEqual({ ...zone, trigger: undefined, label: 'Renamed' });
  });

  it('preserves a remote prompt when only the behavior or agent was edited', () => {
    const latest: ZoneBoardObject = {
      ...zone,
      trigger: { ...zone.trigger!, template: 'Remote prompt' },
    };
    expect(
      applyZoneConfigDraft(latest, initial, {
        ...initial,
        triggerBehavior: 'show_picker',
        triggerAgent: 'claude-code',
      })?.trigger
    ).toEqual({ template: 'Remote prompt', behavior: 'show_picker', agent: 'claude-code' });
  });

  it('creates a new trigger with the picker default but does not normalize untouched fields', () => {
    const empty: ZoneBoardObject = {
      type: 'zone',
      x: 0,
      y: 0,
      width: 200,
      height: 100,
      label: 'New',
    };
    const draft = createZoneConfigDraft(empty, empty.label);
    expect(applyZoneConfigDraft(empty, draft, { ...draft, triggerTemplate: 'New prompt' })).toEqual(
      {
        ...empty,
        trigger: { behavior: 'show_picker', template: 'New prompt', agent: 'claude-code' },
      }
    );
  });

  it('does not resurrect a remotely removed trigger for an agent-only edit', () => {
    expect(
      applyZoneConfigDraft({ ...zone, trigger: undefined }, initial, {
        ...initial,
        triggerAgent: 'claude-code',
      })?.trigger
    ).toBeUndefined();
  });
});
