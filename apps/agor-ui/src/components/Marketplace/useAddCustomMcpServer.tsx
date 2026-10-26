import type { AgorClient, MCPScope, MCPServer, MCPTransport, User } from '@agor-live/client';
import { PlusOutlined } from '@ant-design/icons';
import { Button, Tooltip } from 'antd';
import { type ReactNode, useCallback, useMemo, useRef, useState } from 'react';
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

export interface UseAddCustomMcpServerOptions {
  client: AgorClient | null;
  currentUser?: User | null;
  authGeneration: number;
  capability: MCPServerCapabilityContext;
  /** From `policyPendingState`: the member policy is not known yet. */
  policyState: { pending: boolean; hint: string };
  /** Runs as soon as the form adds its row, which may be before the form closes (OAuth). */
  onCreated?: (server: MCPServer) => void;
  /** Runs when the form closes, with the server it added, if any. */
  onClose?: (created: MCPServer | null) => void;
}

/**
 * The "Add custom server" button and its create form, behind the same gates as
 * the former Settings > MCP Servers create form. Render `modal` once, somewhere
 * that stays mounted while the form is open; `button` may appear in several
 * places and every copy opens that one form.
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
  modal: ReactNode;
  close: () => void;
  /** What this caller may choose in any server form, not only this one. */
  offeredTransports: MCPTransport[];
  offeredScopes: MCPScope[];
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
  const created = useRef<MCPServer | null>(null);
  const close = useCallback(() => setOpen(false), []);

  // Stable across renders, so a memoized host (the Catalog toolbar) stays memoized.
  const button = useMemo(
    () =>
      canAdd ? (
        <Button
          icon={<PlusOutlined />}
          onClick={() => {
            created.current = null;
            setOpen(true);
          }}
        >
          Add custom server
        </Button>
      ) : (
        // A disabled button can't host a tooltip of its own — hence the span.
        <Tooltip title={addRestriction}>
          <span>
            <Button icon={<PlusOutlined />} disabled>
              Add custom server
            </Button>
          </span>
        </Tooltip>
      ),
    [canAdd, addRestriction]
  );

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
      onCreated={(server) => {
        created.current = server;
        onCreated?.(server);
      }}
      onClose={() => {
        setOpen(false);
        onClose?.(created.current);
      }}
    />
  );

  return { button, modal, close, offeredTransports, offeredScopes };
}
