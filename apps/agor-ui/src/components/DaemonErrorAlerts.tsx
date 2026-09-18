import { Alert, Button } from 'antd';

/** Messages come from useAgorClient's safe UI copy, never raw transport errors. */
export function DaemonConnectionAlert({ message }: { message: string }) {
  return <Alert type="error" title={message} showIcon />;
}

/** Keep raw health-fetch errors (which may contain URLs) out of the alert. */
export function DaemonConfigurationAlert({
  unsupportedIdentityContract,
  onRetry,
}: {
  unsupportedIdentityContract: boolean;
  onRetry: () => void;
}) {
  return (
    <Alert
      type="warning"
      title={
        unsupportedIdentityContract
          ? 'Incompatible daemon configuration contract'
          : 'Could not fetch daemon configuration'
      }
      description={
        unsupportedIdentityContract
          ? 'Deploy compatible Agor UI and daemon versions, then retry.'
          : 'Please try again.'
      }
      action={<Button onClick={onRetry}>Retry</Button>}
      showIcon
    />
  );
}
