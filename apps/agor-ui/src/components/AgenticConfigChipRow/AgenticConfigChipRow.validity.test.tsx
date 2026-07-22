/**
 * The chip row reports config validity so the modal can gate creation. When the
 * admin disallows inline config and no preset/workspace default exists, the
 * selected source can't resolve — mirroring the daemon's create-time error.
 */

import type { AgorClient, User } from '@agor-live/client';
import { render, waitFor } from '@testing-library/react';
import { Form } from 'antd';
import { describe, expect, it, vi } from 'vitest';
import { AgenticConfigChipRow } from './AgenticConfigChipRow';

// Inline configuration is NOT allowed for claude-code in this workspace.
vi.mock('../../store/agorStore', () => ({
  useAgorStore: (selector: (state: unknown) => unknown) =>
    selector({
      agenticToolSettingsByName: new Map([
        ['claude-code', { inline_configuration_allowed: false }],
      ]),
    }),
}));
vi.mock('../ModelSelector', async () => {
  const actual = await vi.importActual<typeof import('../ModelSelector')>('../ModelSelector');
  return { ...actual, ModelSelector: () => null, AdvisorModelSelect: () => null };
});
vi.mock('../PermissionModeSelector', async () => {
  const actual = await vi.importActual<typeof import('../PermissionModeSelector')>(
    '../PermissionModeSelector'
  );
  return { ...actual, PermissionModeSelector: () => null };
});
vi.mock('../EffortSelector', () => ({ EffortSelector: () => null }));
vi.mock('../MCPServerSelect', () => ({ MCPServerSelect: () => null }));

const userNoDefault = { user_id: 'u1', default_agentic_config: {} } as unknown as User;

describe('AgenticConfigChipRow config validity', () => {
  it('reports invalid when inline is disallowed and no preset exists', async () => {
    const onValidity = vi.fn();
    let resolvePresets: ((value: { data: [] }) => void) | undefined;
    const presets = new Promise<{ data: [] }>((resolve) => {
      resolvePresets = resolve;
    });
    const client = {
      service: () => ({ find: () => presets, on: () => {}, off: () => {} }),
    } as unknown as AgorClient;
    render(
      <Form>
        <AgenticConfigChipRow
          tool="claude-code"
          client={client}
          mcpServerById={new Map()}
          currentUser={userNoDefault}
          onConfigValidityChange={onValidity}
        />
      </Form>
    );

    await waitFor(() => {
      expect(onValidity).toHaveBeenLastCalledWith(false, 'Loading configuration');
    });

    resolvePresets?.({ data: [] });
    await waitFor(() => {
      expect(onValidity).toHaveBeenLastCalledWith(false, expect.stringContaining('preset'));
    });
  });
});
