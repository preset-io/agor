import type { describeActionError } from '../../utils/connectionErrors';
import { CompactNotice, type CompactNoticeAction, type CompactNoticeProps } from './CompactNotice';

interface ActionErrorNoticeProps extends Omit<CompactNoticeProps, 'type' | 'message' | 'details'> {
  error: ReturnType<typeof describeActionError>;
  action?: CompactNoticeAction;
}

/** A failed save inside a form: the formatter's copy, with the raw error under Details. */
export function ActionErrorNotice({ error, action, ...rest }: ActionErrorNoticeProps) {
  return (
    <CompactNotice
      type="error"
      role="alert"
      message={error.message}
      details={error.raw ? [{ label: 'Error', value: error.raw, code: true }] : undefined}
      actions={action ? [action] : undefined}
      {...rest}
    />
  );
}
