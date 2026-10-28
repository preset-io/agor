import type { AgorClient, MCPServer, User } from '@agor-live/client';
import { hasMinimumRole, ROLES } from '@agor-live/client';
import { PlusOutlined } from '@ant-design/icons';
import { Button, Tooltip } from 'antd';
import { useMemo, useRef, useState } from 'react';
import { LOST_CONNECTION_TOOLTIP } from '@/utils/connectionErrors';
import { useMcpMemberPolicy } from '../../hooks/useMcpMemberPolicy';
import { MCPServerEditModal } from '../MCPServer/MCPServerEditModal';
import {
  allowedMcpScopes,
  allowedMcpTransports,
  canAddMcpServer,
  canAddSharedMcpServer,
  canEditMcpServer,
  explainAddRestriction,
  type MCPServerCapabilityContext,
  policyPendingState,
} from '../MCPServer/memberPolicy';

const LABEL = 'Add custom server';

export type CustomServerEditPurpose = 'configuration' | 'credential';

type Editing =
  | { mode: 'create' }
  | { mode: 'edit'; server: MCPServer; purpose: CustomServerEditPurpose };

export interface UseCustomMcpServerEditorOptions {
  client: AgorClient | null;
  connected: boolean;
  connecting: boolean;
  authGeneration: number;
  currentUser?: User | null;
  /**
   * Runs when the editor closes, with the server it added or edited, if any. A
   * create counts once its row is first persisted (on Create, or before an
   * OAuth start), so a form cancelled after OAuth preparation still reports it.
   */
  onClose?: (serverId: string | null) => void;
}

/**
 * The custom-server editor of the MCP Catalog: the "Add custom server" action
 * and the in-place view that adds or edits a server. The view replaces the
 * host's content (no modal over the Catalog modal), like a Settings drill-in;
 * the host renders `view.editor` under a breadcrumb of `view.trail` and
 * `view.current`, with `back` as the way out.
 */
export function useCustomMcpServerEditor({
  client,
  connected,
  connecting,
  authGeneration,
  currentUser,
  onClose,
}: UseCustomMcpServerEditorOptions) {
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
  const offeredTransports = useMemo(
    () => allowedMcpTransports({ isAdmin: capability.isAdmin }),
    [capability.isAdmin]
  );
  const offeredScopes = useMemo(
    () => allowedMcpScopes({ isAdmin: capability.isAdmin, policy: capability.policy }),
    [capability.isAdmin, capability.policy]
  );
  const [editing, setEditing] = useState<Editing | null>(null);
  // The row a create persisted, reported on close rather than mid-OAuth.
  const created = useRef<string | null>(null);

  const [button, iconButton] = useMemo(() => {
    const render = (iconOnly: boolean) => {
      const control = (
        <Button
          // The label (text or aria-label) names the button, not the icon's "plus".
          icon={<PlusOutlined aria-hidden />}
          disabled={!canAdd}
          aria-label={iconOnly ? LABEL : undefined}
          onClick={() => {
            created.current = null;
            setEditing({ mode: 'create' });
          }}
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

  const back = () => {
    const serverId = editing?.mode === 'edit' ? editing.server.mcp_server_id : created.current;
    created.current = null;
    setEditing(null);
    onClose?.(serverId);
  };

  const server = editing?.mode === 'edit' ? editing.server : null;
  const mutationAllowed = server
    ? !policyState.pending &&
      canEditMcpServer(
        { owner_user_id: server.owner_user_id ?? undefined, transport: server.transport },
        capability
      )
    : canAdd;
  const authorityKey =
    mutationAllowed && currentUser
      ? `${currentUser.user_id}:${currentUser.role}:${authGeneration}`
      : null;

  const view = editing && {
    trail: server ? ['My Servers', server.display_name || server.name] : [],
    current: !server
      ? LABEL
      : editing.mode === 'edit' && editing.purpose === 'credential'
        ? 'Edit credential'
        : 'Edit configuration',
    editor: (
      <MCPServerEditModal
        embedded
        server={server}
        open
        client={client}
        identityKey={currentUser?.user_id ?? null}
        authGeneration={authGeneration}
        authorityKey={authorityKey}
        offeredTransports={offeredTransports}
        offeredScopes={offeredScopes}
        allowSharedOwnership={canAddSharedMcpServer(capability)}
        mutationAllowed={mutationAllowed}
        mutationBlockedReason={server ? undefined : addRestriction}
        onCreated={(added) => {
          created.current = added.mcp_server_id;
        }}
        onClose={back}
      />
    ),
  };

  return {
    button,
    iconButton,
    /** The in-place editor, or null while the host shows its own content. */
    view,
    back,
    openEdit: (target: MCPServer, purpose: CustomServerEditPurpose) =>
      setEditing({ mode: 'edit', server: target, purpose }),
  };
}
