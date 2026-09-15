import { Alert } from 'antd';

/** Shared disclosure for configuring or selecting branch cleanup. */
export function BranchCleanupWarning() {
  return (
    <Alert
      type="warning"
      showIcon
      description="When enabled, this command runs when branch cleanup is requested, typically to reclaim disk space. It may delete valuable files—including ignored .env files or tracked files with custom commands. Agor cannot undo these changes."
    />
  );
}
