import type { ButtonProps } from 'antd';
import { Button, Tooltip } from 'antd';
import type { ReactNode } from 'react';
import { useMutationGate } from '../../contexts/ConnectionContext';

/**
 * MutateButton - drop-in replacement for <Button> that auto-disables when
 * the app cannot safely mutate server state (disconnected, reconnecting,
 * out-of-sync).
 *
 * The disabled-because-disconnected reason is surfaced via a tooltip so the
 * user understands *why* the button is grayed out.
 *
 * Use this for any button that triggers a server-mutating action: create,
 * update, delete, send-prompt, fork, spawn, drag-confirm, etc. For pure
 * local-state buttons (toggle a panel, expand a sidebar) keep using the
 * regular <Button>.
 */
export interface MutateButtonProps extends ButtonProps {
  /** Tooltip shown when the button is enabled. When disabled by the gate, a
   *  reason-specific tooltip is shown instead. */
  tooltip?: ReactNode;
}

export const MutateButton: React.FC<MutateButtonProps> = ({
  tooltip,
  disabled,
  children,
  ...rest
}) => {
  const gate = useMutationGate();
  const finalDisabled = disabled || !gate.canMutate;
  const finalTooltip = !gate.canMutate ? gate.message : tooltip;

  const button = (
    <Button {...rest} disabled={finalDisabled}>
      {children}
    </Button>
  );

  return finalTooltip ? <Tooltip title={finalTooltip}>{button}</Tooltip> : button;
};
