import type { MCPCatalogEntry } from '@agor/core/types';
import { load } from '@agor/core/yaml';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { userEvent } from 'vitest/browser';
import catalogYaml from '../../../../../packages/core/src/mcp-catalog/curated.yaml?raw';
import { OAUTH_PROVIDER_FIXTURES } from '../../../../../packages/core/src/tools/mcp/oauth-provider.test-fixtures';
import { checkBrowserSanity } from '../../test/browserSanity';
import { CatalogDetailDrawer } from './CatalogDetailDrawer';
import { connectStatus, isConnectable } from './catalogPresentation';

checkBrowserSanity();
beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = false;
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});
const catalog = load(catalogYaml) as { entries: MCPCatalogEntry[]; unpublished: MCPCatalogEntry[] };

describe('provider setup failures in real Chromium', () => {
  it.each(OAUTH_PROVIDER_FIXTURES)(
    '$label offers truthful guidance instead of another registration',
    async ({ name, label }) => {
      const entry = [...catalog.entries, ...catalog.unpublished].find(
        (entry) => entry.name === name
      )!;
      const onConnect = vi.fn();
      const popup = vi.spyOn(window, 'open');
      render(
        <CatalogDetailDrawer
          identityKey="tenant-a:user-a"
          entry={{ ...entry, title: label, icon_url: undefined, has_remote: true }}
          open
          onClose={vi.fn()}
          branches={[]}
          branchesLoading={false}
          branchesError={null}
          connecting={false}
          connectError={null}
          onConnect={onConnect}
          // A stale successful probe must not override reviewed setup policy.
          credentialRequirement="oauth"
          connectCapability={{
            connectionReady: true,
            role: 'admin',
            isAdmin: true,
            policy: 'allow_crud',
            userId: 'user-a',
            canConfigure: true,
          }}
          policyPending={false}
          policyPendingHint="Loading policy"
          defaultBranchId={null}
        />
      );
      expect(isConnectable(entry)).toBe(false);
      expect(connectStatus(entry).label).toBe('Provider setup required');
      const guidance = await screen.findByText(entry.setup_required!.message);
      guidance.scrollIntoView();
      expect(guidance.getBoundingClientRect().height).toBeGreaterThan(0);
      const link = screen.getByRole('link', { name: 'Provider setup guide' });
      expect(link).toHaveAttribute('href', entry.setup_required!.documentation_url);
      expect(link).toHaveAttribute('rel', 'noopener noreferrer');
      expect(screen.queryByRole('button', { name: /^Connect with|^Check & connect/ })).toBeNull();
      // Disclosure remains inspectable and keyboard-operable; it cannot grant setup approval.
      const disclosure = screen.getByRole('button', { name: /What this can access/ });
      await userEvent.click(disclosure);
      await userEvent.click(disclosure);
      expect(screen.getByText(entry.setup_required!.message)).toBeVisible();
      await waitFor(() => {
        const bounds = screen.getByRole('dialog').getBoundingClientRect();
        expect(bounds.left).toBeGreaterThanOrEqual(0);
        expect(bounds.right).toBeLessThanOrEqual(window.innerWidth + 1);
      });
      expect(onConnect).not.toHaveBeenCalled();
      expect(popup).not.toHaveBeenCalled();
      expect(document.body.textContent).not.toContain('SENTINEL');
    }
  );
});
