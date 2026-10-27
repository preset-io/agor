import type { AgorClient, MCPServer, User } from '@agor-live/client';
import { hasMinimumRole, ROLES } from '@agor-live/client';
import { PlusOutlined } from '@ant-design/icons';
import { Button, Tooltip } from 'antd';
import { type ReactNode, useMemo, useState } from 'react';
import { LOST_CONNECTION_TOOLTIP } from '@/utils/connectionErrors';
import { useMcpMemberPolicy } from '../../hooks/useMcpMemberPolicy';
import { MCPServerEditModal } from '../MCPServer/MCPServerEditModal';
import {
  allowedMcpScopes,
  allowedMcpTransports,
  canAddMcpServer,
  canAddSharedMcpServer,
  explainAddRestriction,
  type MCPServerCapabilityContext,
  policyPendingState,
} from '../MCPServer/memberPolicy';

const LABEL = 'Add custom server';

export interface UseAddCustomMcpServerOptions {
  client: AgorClient | null;
  connected: boolean;
  connecting: boolean;
  authGeneration: number;
  currentUser?: User | null;
  /**
   * Runs once, when the form first persists its row: on Create, or before an
   * OAuth start, so a form cancelled after that still reports the server.
   */
  onCreated?: (server: MCPServer) => void;
  onClose?: () => void;
}

/**
 * The "Add custom server" action and its create form, behind the same gates as
 * the former Settings > MCP Servers create form. Render `modal` once, somewhere
 * that stays mounted while the form is open; `button` (or `iconButton`, for
 * narrow layouts) may appear in several places and every copy opens that form.
 */
export function useAddCustomMcpServer({
  client,
  connected,
  connecting,
  authGeneration,
  currentUser,
  onCreated,
  onClose,
}: UseAddCustomMcpServerOptions): {
  button: ReactNode;
  iconButton: ReactNode;
  modal: ReactNode;
} {
  const connectionReady = connected && !connecting;
  const memberPolicy = useMcpMemberPolicy(client, {
    connectionReady,
    currentUser,
    authGeneration,
  });
  const policyState = policyPendingState(memberPolicy);
  const capability: MCPServerCapabilityContext = {
    role: currentUser?.role,
    isAdmin: hasMinimumRole(currentUser?.role, ROLES.ADMIN),
    connectionReady,
    policy: memberPolicy.policy,
    userId: currentUser?.user_id,
    canConfigure: memberPolicy.canConfigure,
  };
  const canAdd = !policyState.pending && canAddMcpServer(capability);
  const addRestriction = !connectionReady
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

  const [button, iconButton] = useMemo(() => {
    const render = (iconOnly: boolean) => {
      const control = (
        <Button
          type="primary"
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

  return { button, iconButton, modal };
}
