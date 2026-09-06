import { environmentStartConfirmation } from '@agor/core/types';
import type { AgorClient } from '@agor-live/client';
import { useThemedModal } from '../utils/modal';

export function useEnvironmentStart(client: AgorClient | null) {
  const { confirm } = useThemedModal();
  return async (branchId: string): Promise<boolean> => {
    if (!client) return false;
    const branch = await client.service('branches').get(branchId);
    const confirmationOf = environmentStartConfirmation(branch.environment_instance);
    if (confirmationOf) {
      const accepted = await new Promise<boolean>((resolve) =>
        confirm({
          title: 'Previous environment cleanup is unconfirmed',
          content:
            'The previous command failed, timed out, or did not report a result. Starting again may leave additional remote resources running and incurring charges. Depending on your scripts, Agor may no longer be able to stop the previous environment.',
          okText: 'Start anyway',
          okType: 'danger',
          cancelText: 'Cancel',
          onOk: () => resolve(true),
          onCancel: () => resolve(false),
        })
      );
      if (!accepted) return false;
    }
    await client
      .service(`branches/${branchId}/start`)
      .create(confirmationOf ? { confirmation_of: confirmationOf } : {});
    return true;
  };
}
