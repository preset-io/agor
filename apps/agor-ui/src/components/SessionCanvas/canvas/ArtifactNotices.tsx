import { Component, type CSSProperties, type ReactNode } from 'react';
import { copyToClipboard } from '@/utils/clipboard';
import { useThemedMessage } from '@/utils/message';
import { CompactNotice } from '../../CompactNotice';
import { type ArtifactLoadFailure, describeArtifactLoadFailure } from './artifactLoadError';

export function ArtifactLoadErrorNotice({
  failure,
  onRetry,
  className,
  style,
}: {
  failure: ArtifactLoadFailure;
  onRetry: () => void;
  className?: string;
  style?: CSSProperties;
}) {
  const notice = describeArtifactLoadFailure(failure);
  return (
    <CompactNotice
      type="error"
      role="alert"
      message={notice.message}
      actions={notice.canRetry ? [{ label: 'Try again', onClick: onRetry }] : undefined}
      details={notice.details}
      className={className}
      style={style}
    />
  );
}

export function ArtifactLegacyNotice({
  upgradeInstructions,
  className,
  style,
}: {
  upgradeInstructions: string;
  className?: string;
  style?: CSSProperties;
}) {
  const { showSuccess, showError } = useThemedMessage();
  const handleCopy = async () => {
    const ok = await copyToClipboard(upgradeInstructions);
    if (ok) showSuccess('Upgrade prompt copied. Paste it into a session to update the artifact.');
    else showError("Couldn't copy. Select the text and copy it manually.");
  };
  return (
    <CompactNotice
      type="warning"
      message="This artifact uses an older format and may not display correctly."
      actions={[{ label: 'Copy upgrade prompt', onClick: handleCopy }]}
      details={[{ label: 'Upgrade prompt', value: upgradeInstructions }]}
      className={className}
      style={style}
    />
  );
}

/**
 * Contains a failed artifact chunk or render to its own node, instead of the
 * global crash screen. A rejected React.lazy import stays cached, so only a
 * page reload can fetch it again.
 */
export class ArtifactLoadBoundary extends Component<
  { children: ReactNode; style?: CSSProperties },
  { error: Error | null }
> {
  state: { error: Error | null } = { error: null };

  static getDerivedStateFromError(error: Error) {
    return { error };
  }

  render() {
    const { error } = this.state;
    if (!error) return this.props.children;
    return (
      <CompactNotice
        type="error"
        role="alert"
        message="Couldn't load this artifact."
        actions={[{ label: 'Reload page', onClick: () => window.location.reload() }]}
        details={[{ label: 'Error', value: error.message || String(error), code: true }]}
        className="nodrag nopan"
        style={this.props.style}
      />
    );
  }
}
