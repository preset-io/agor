import { describe, expect, it } from 'vitest';
import {
  applyCapabilityPreset,
  BRANCH_ACCESS_EDITOR_CONTEXT,
  toggleCapability,
} from './policyEditorModel';

const grant = {
  preset: 'none' as const,
  capabilities: [],
  fs_access: 'none' as const,
};

describe('capability policy editor model', () => {
  it('keeps Manager independent from prompt and execution capabilities', () => {
    const manager = applyCapabilityPreset(grant, BRANCH_ACCESS_EDITOR_CONTEXT, 'manager');

    expect(manager.capabilities).toEqual(
      expect.arrayContaining([
        'branch.view',
        'sessions.manage_others',
        'branch.manage',
        'environment.control',
        'branch.policy.manage',
      ])
    );
    expect(manager.capabilities).not.toEqual(
      expect.arrayContaining(['sessions.create', 'sessions.prompt_own', 'terminal.open'])
    );
  });

  it('makes invalid dependency combinations impossible through capability toggles', () => {
    const withPrompt = toggleCapability(
      grant,
      BRANCH_ACCESS_EDITOR_CONTEXT,
      'sessions.prompt_own',
      true
    );
    expect(withPrompt.capabilities).toEqual([
      'branch.view',
      'sessions.create',
      'sessions.prompt_own',
    ]);

    const withoutView = toggleCapability(
      withPrompt,
      BRANCH_ACCESS_EDITOR_CONTEXT,
      'branch.view',
      false
    );
    expect(withoutView.capabilities).toEqual([]);
  });
});
