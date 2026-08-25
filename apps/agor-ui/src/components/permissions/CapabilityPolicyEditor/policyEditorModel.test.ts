import { describe, expect, it } from 'vitest';
import {
  applyCapabilityPreset,
  BRANCH_ACCESS_EDITOR_CONTEXT,
  toggleCapability,
  toggleCapabilityControlGroup,
  updateFilesystemAccess,
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

  it('bundles session creation and prompting as Work in own sessions', () => {
    const work = BRANCH_ACCESS_EDITOR_CONTEXT.controlGroups.find((group) => group.id === 'work');
    if (!work) throw new Error('Missing Work in own sessions control group');

    const withFiles = updateFilesystemAccess(grant, BRANCH_ACCESS_EDITOR_CONTEXT, 'read');
    const collaborator = toggleCapabilityControlGroup(
      withFiles,
      BRANCH_ACCESS_EDITOR_CONTEXT,
      work,
      true
    );

    expect(collaborator.capabilities).toEqual([
      'branch.view',
      'sessions.create',
      'sessions.prompt_own',
      'terminal.open',
    ]);
    expect(collaborator.preset).toBe('collaborator');
  });

  it('derives terminal from own-session work plus files, never files alone', () => {
    const collaborator = applyCapabilityPreset(grant, BRANCH_ACCESS_EDITOR_CONTEXT, 'collaborator');
    const withoutFiles = updateFilesystemAccess(collaborator, BRANCH_ACCESS_EDITOR_CONTEXT, 'none');
    const manager = applyCapabilityPreset(grant, BRANCH_ACCESS_EDITOR_CONTEXT, 'manager');

    expect(withoutFiles.capabilities).not.toContain('terminal.open');
    expect(withoutFiles.capabilities).toEqual([
      'branch.view',
      'sessions.create',
      'sessions.prompt_own',
    ]);
    expect(manager.fs_access).toBe('write');
    expect(manager.capabilities).not.toContain('terminal.open');
  });
});
