import type { AgorClient, MCPServer, User } from '@agor-live/client';
import { PlusOutlined } from '@ant-design/icons';
import { Button, Tooltip } from 'antd';
import { type ReactNode, useCallback, useMemo, useState } from 'react';
import { LOST_CONNECTION_TOOLTIP } from '@/utils/connectionErrors';
import { MCPServerEditModal } from '../MCPServer/MCPServerEditModal';
import {
  allowedMcpScopes,
  allowedMcpTransports,
  canAddMcpServer,
  canAddSharedMcpServer,
  explainAddRestriction,
  type MCPServerCapabilityContext,
} from '../MCPServer/memberPolicy';

const LABEL = 'Add custom server';

export interface UseAddCustomMcpServerOptions {
  client: AgorClient | null;
  currentUser?: User | null;
  authGeneration: number;
  capability: MCPServerCapabilityContext;
  /** From `policyPendingState`: the member policy is not known yet. */
  policyState: { pending: boolean; hint: string };
  /**
   * Runs once, when the form first persists its row: on Create, or before an
   * OAuth start, so a form cancelled after that still reports the server.
   */
  onCreated?: (server: MCPServer) => void;
  onClose?: () => void;
}

/**
 * The "Add custom server" button and its create form, behind the same gates as
 * the former Settings > MCP Servers create form. Render `modal` once, somewhere
 * that stays mounted while the form is open; `button` (or `iconButton`, for
 * tight toolbars) may appear in several places and every copy opens that form.
 */
export function useAddCustomMcpServer({
  client,
  currentUser,
  authGeneration,
  capability,
  policyState,
  onCreated,
  onClose,
}: UseAddCustomMcpServerOptions): {
  button: ReactNode;
  iconButton: ReactNode;
  modal: ReactNode;
  close: () => void;
} {
  const canAdd = !policyState.pending && canAddMcpServer(capability);
  const addRestriction = !capability.connectionReady
    ? LOST_CONNECTION_TOOLTIP
    : policyState.pending
      ? policyState.hint
      : explainAddRestriction(capability);
  const createAuthorityKey =
    canAdd && currentUser ? `${currentUser.user_id}:${currentUser.role}:${authGeneration}` : null;
  const offeredTransports = useMemo(
    () => allowedMcpTransports({ isAdmin: capability.isAdmin }),
    [capability.isAdmin]
  );
  const offeredScopes = useMemo(
    () => allowedMcpScopes({ isAdmin: capability.isAdmin, policy: capability.policy }),
    [capability.isAdmin, capability.policy]
  );
  const [open, setOpen] = useState(false);
  const close = useCallback(() => setOpen(false), []);

  // Stable across renders, so a memoized host (the Catalog toolbar) stays memoized.
  const [button, iconButton] = useMemo(() => {
    const render = (iconOnly: boolean) => {
      const control = (
        <Button
          // The label (text or aria-label) names the button, not the icon's "plus".
          icon={<PlusOutlined aria-hidden />}
          disabled={!canAdd}
          aria-label={iconOnly ? LABEL : undefined}
          onClick={() => setOpen(true)}
        >
          {iconOnly ? null : LABEL}
        </Button>
      );
      const tooltip = canAdd ? (iconOnly ? LABEL : null) : addRestriction;
      if (!tooltip) return control;
      // A disabled button can't host a tooltip of its own — hence the span.
      return (
        <Tooltip title={tooltip}>
          <span>{control}</span>
        </Tooltip>
      );
    };
    return [render(false), render(true)];
  }, [canAdd, addRestriction]);

  const modal = (
    <MCPServerEditModal
      server={null}
      open={open}
      client={client}
      identityKey={currentUser?.user_id ?? null}
      authGeneration={authGeneration}
      authorityKey={createAuthorityKey}
      offeredTransports={offeredTransports}
      offeredScopes={offeredScopes}
      allowSharedOwnership={canAddSharedMcpServer(capability)}
      mutationAllowed={canAdd}
      mutationBlockedReason={addRestriction}
      onCreated={onCreated}
      onClose={() => {
        setOpen(false);
        onClose?.();
      }}
    />
  );

  return { button, iconButton, modal, close };
}
