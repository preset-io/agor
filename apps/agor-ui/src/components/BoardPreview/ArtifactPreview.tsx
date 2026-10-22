import type { AgorClient } from '@agor-live/client';
import { Flex, Typography, theme } from 'antd';
import { ArtifactTrustStatusIcon } from '../artifacts/ArtifactRenderSupport';
import { ArtifactSandbox, useArtifactSandbox } from '../artifacts/ArtifactSandbox';

/**
 * A live artifact in the preview: the same sandbox as the full screen artifact
 * page. Secrets wait for trust, as there; the trust mark opens the same consent.
 */
export const ArtifactPreview: React.FC<{ client: AgorClient | null; artifactId: string }> = ({
  client,
  artifactId,
}) => {
  const { token } = theme.useToken();
  const sandbox = useArtifactSandbox(client, artifactId);
  const { payload } = sandbox;
  const needsTrust = payload && payload.trust_state !== 'no_secrets_needed';
  return (
    <Flex vertical style={{ height: '100%' }}>
      {needsTrust && (
        <Flex
          align="center"
          gap={token.marginXS}
          style={{
            flexShrink: 0,
            padding: `${token.paddingXXS}px ${token.paddingSM}px`,
            borderBottom: `1px solid ${token.colorBorderSecondary}`,
          }}
        >
          <ArtifactTrustStatusIcon
            payload={payload}
            onTrustClick={() => sandbox.setConsentOpen(true)}
          />
          <Typography.Text type="secondary" style={{ fontSize: token.fontSizeSM }}>
            {payload.trust_state === 'untrusted'
              ? 'Secrets are locked until you trust this artifact.'
              : 'Secrets are available to this artifact.'}
          </Typography.Text>
        </Flex>
      )}
      <Flex
        style={{ flex: 1, minHeight: 0 }}
        align={sandbox.loading && !payload ? 'center' : 'stretch'}
        justify={sandbox.loading && !payload ? 'center' : 'stretch'}
      >
        <ArtifactSandbox sandbox={sandbox} />
      </Flex>
    </Flex>
  );
};
