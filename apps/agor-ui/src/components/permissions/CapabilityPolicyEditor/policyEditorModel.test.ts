import { describe, expect, it } from 'vitest';
import {
  applyCapabilityPreset,
  BRANCH_ACCESS_EDITOR_CONTEXT,
  updateFilesystemAccess,
} from './policyEditorModel';

const grant = {
  preset: 'none' as const,
  capabilities: [],
  fs_access: 'none' as const,
};

describe('capability policy editor model', () => {
  it('calls read-only branch access Viewer without implying prompt access', () => {
    const viewerDefinition = BRANCH_ACCESS_EDITOR_CONTEXT.presets.find(
      (preset) => preset.id === 'viewer'
    );
    const viewer = applyCapabilityPreset(grant, BRANCH_ACCESS_EDITOR_CONTEXT, 'viewer');

    expect(viewerDefinition?.label).toBe('Viewer');
    expect(viewer).toEqual({
      preset: 'viewer',
      capabilities: ['branch.view'],
      fs_access: 'none',
    });
  });

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

  it('keeps the selected role stable when file access changes independently', () => {
    const viewer = applyCapabilityPreset(grant, BRANCH_ACCESS_EDITOR_CONTEXT, 'viewer');
    const withFiles = updateFilesystemAccess(viewer, BRANCH_ACCESS_EDITOR_CONTEXT, 'write');

    expect(withFiles).toEqual({
      preset: 'viewer',
      capabilities: ['branch.view'],
      fs_access: 'write',
    });
  });

  it('maps Collaborator to own-session work and derives terminal only with files', () => {
    const collaboratorWithoutFiles = applyCapabilityPreset(
      grant,
      BRANCH_ACCESS_EDITOR_CONTEXT,
      'collaborator'
    );
    const collaborator = updateFilesystemAccess(
      collaboratorWithoutFiles,
      BRANCH_ACCESS_EDITOR_CONTEXT,
      'read'
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
    const collaborator = applyCapabilityPreset(
      { ...grant, fs_access: 'read' as const },
      BRANCH_ACCESS_EDITOR_CONTEXT,
      'collaborator'
    );
    const withoutFiles = updateFilesystemAccess(collaborator, BRANCH_ACCESS_EDITOR_CONTEXT, 'none');
    const manager = applyCapabilityPreset(
      { ...grant, fs_access: 'write' as const },
      BRANCH_ACCESS_EDITOR_CONTEXT,
      'manager'
    );

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
