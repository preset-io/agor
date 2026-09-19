import type { AgenticToolName, ZoneBoardObject, ZoneTriggerBehavior } from '@agor-live/client';
import { isAgenticToolName } from '@agor-live/client';
import { sanitizeZoneFontSize } from './zoneFontSize';

export interface ZoneConfigDraft {
  name: string;
  locked: boolean;
  triggerBehavior: ZoneTriggerBehavior;
  triggerTemplate: string;
  triggerAgent: AgenticToolName | null;
  borderColor?: string;
  backgroundColor?: string;
  fontSize?: number;
  clearLegacyColor: boolean;
}

export function createZoneConfigDraft(zone: ZoneBoardObject, name: string): ZoneConfigDraft {
  const agent = zone.trigger?.agent;
  return {
    name,
    locked: Boolean(zone.locked),
    triggerBehavior: zone.trigger?.behavior ?? 'show_picker',
    triggerTemplate: zone.trigger?.template ?? '',
    triggerAgent: agent === undefined ? 'claude-code' : isAgenticToolName(agent) ? agent : null,
    borderColor: zone.borderColor,
    backgroundColor: zone.backgroundColor,
    fontSize: sanitizeZoneFontSize(zone.fontSize),
    clearLegacyColor: false,
  };
}

/**
 * Upserts replace the entire zone. Overlay only edits relative to the opening
 * draft, not every field in the form, onto the freshest received zone. Explicit
 * empty strings/undefined resets are edits too. This preserves received live
 * updates; it does not provide server-side compare-and-swap for in-flight writes.
 */
export function applyZoneConfigDraft(
  zone: ZoneBoardObject,
  initial: ZoneConfigDraft,
  draft: ZoneConfigDraft
): ZoneBoardObject | undefined {
  const changes: Partial<ZoneBoardObject> = {};
  if (draft.name !== initial.name) changes.label = draft.name;
  if (draft.locked !== initial.locked) changes.locked = draft.locked;
  if (draft.borderColor !== initial.borderColor) changes.borderColor = draft.borderColor;
  if (draft.backgroundColor !== initial.backgroundColor)
    changes.backgroundColor = draft.backgroundColor;
  if (draft.fontSize !== initial.fontSize) changes.fontSize = draft.fontSize;
  if (draft.clearLegacyColor) changes.color = undefined;

  const templateChanged = draft.triggerTemplate !== initial.triggerTemplate;
  const behaviorChanged = draft.triggerBehavior !== initial.triggerBehavior;
  const agentChanged = draft.triggerAgent !== initial.triggerAgent;
  if (templateChanged || behaviorChanged || agentChanged) {
    const template = templateChanged
      ? draft.triggerTemplate.trim()
      : (zone.trigger?.template ?? '');
    changes.trigger = template
      ? {
          ...zone.trigger,
          template,
          behavior: behaviorChanged
            ? draft.triggerBehavior
            : (zone.trigger?.behavior ?? draft.triggerBehavior),
          agent: agentChanged
            ? (draft.triggerAgent ?? undefined)
            : (zone.trigger?.agent ?? draft.triggerAgent ?? undefined),
        }
      : undefined;
  }

  return Object.keys(changes).length ? { ...zone, ...changes } : undefined;
}
