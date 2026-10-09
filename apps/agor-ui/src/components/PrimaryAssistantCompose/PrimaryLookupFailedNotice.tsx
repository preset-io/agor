import { CompactNotice } from '../CompactNotice';

/** The primary-assistant lookup failed: never treated as "no primary", so the picker stays hidden. */
export function PrimaryLookupFailedNotice({
  connected,
  retrying,
  onRetry,
}: {
  connected: boolean;
  retrying: boolean;
  onRetry: () => void;
}) {
  return (
    <CompactNotice
      type="error"
      role="alert"
      message={
        connected
          ? "Couldn't load your primary assistant."
          : "Couldn't load your primary assistant. The connection to Agor dropped. Try again once it's back."
      }
      actions={
        connected ? [{ label: 'Try again', onClick: onRetry, loading: retrying }] : undefined
      }
    />
  );
}
