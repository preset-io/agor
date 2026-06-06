import type { AgorClient, Artifact, ArtifactPayload, User } from '@agor-live/client';
import {
  ArrowLeftOutlined,
  EyeInvisibleOutlined,
  ReloadOutlined,
  WarningOutlined,
} from '@ant-design/icons';
import { SandpackPreview, SandpackProvider, type SandpackSetup } from '@codesandbox/sandpack-react';
import { Alert, Button, Layout, Space, Spin, Tooltip, Typography, theme } from 'antd';
import { useCallback, useEffect, useRef, useState } from 'react';
import { useParams, useSearchParams } from 'react-router-dom';
import {
  ArtifactConsoleReporter,
  ArtifactRuntimeBridge,
  ArtifactSandpackErrorReporter,
  renderArtifactTrustBadge,
} from '@/components/artifacts/ArtifactRenderSupport';
import { getDaemonUrl } from '@/config/daemon';
import { getAuthHeaders } from '@/utils/authHeaders';
import { ensureSandpackCryptoSubtle } from '@/utils/sandpackCrypto';
import { ArtifactConsentModal } from '../components/ArtifactConsentModal/ArtifactConsentModal';
import { BrandLogo } from '../components/BrandLogo';
import { GlobalUserMenu } from '../components/GlobalUserMenu';
import { withBodyReset } from '../components/SessionCanvas/canvas/utils/sandpackDefaults';
import { ThemeSwitcher } from '../components/ThemeSwitcher';

ensureSandpackCryptoSubtle();

const { Header, Content } = Layout;
const { Title } = Typography;

interface ArtifactFullscreenPageProps {
  client: AgorClient | null;
  currentUser?: User | null;
  onUserSettingsClick?: () => void;
  onLogout?: () => void;
}

interface ArtifactFullscreenNavbarProps {
  artifact: Artifact | null;
  payload: ArtifactPayload | null;
  title: string;
  loading: boolean;
  currentUser?: User | null;
  onReload: () => void;
  onTrustClick: () => void;
  onHideNavbar: () => void;
  onUserSettingsClick?: () => void;
  onLogout?: () => void;
}

function ArtifactFullscreenNavbar({
  artifact,
  payload,
  title,
  loading,
  currentUser,
  onReload,
  onTrustClick,
  onHideNavbar,
  onUserSettingsClick,
  onLogout,
}: ArtifactFullscreenNavbarProps) {
  const { token } = theme.useToken();
  const trustBadge = payload ? renderArtifactTrustBadge(payload, onTrustClick) : null;

  return (
    <Header
      style={{
        height: 56,
        padding: '0 16px',
        background: token.colorBgContainer,
        borderBottom: `1px solid ${token.colorBorderSecondary}`,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        gap: 16,
      }}
    >
      <Space size={12} style={{ minWidth: 0, flex: 1, overflow: 'hidden' }}>
        <Button
          type="text"
          icon={<ArrowLeftOutlined />}
          href={artifact?.url ?? undefined}
          disabled={!artifact?.url}
        >
          Board
        </Button>
        <BrandLogo level={5} />
        <div
          style={{
            minWidth: 0,
            maxWidth: 420,
            display: 'flex',
            alignItems: 'center',
            gap: 4,
          }}
        >
          <Title
            level={5}
            style={{ margin: 0, lineHeight: 1.2, minWidth: 0, flex: '1 1 auto' }}
            ellipsis
          >
            {title}
          </Title>
          <Tooltip title="Hide navbar">
            <Button
              type="text"
              size="small"
              aria-label="Hide navbar"
              icon={<EyeInvisibleOutlined />}
              onClick={onHideNavbar}
              style={{
                display: 'inline-flex',
                alignItems: 'center',
                justifyContent: 'center',
                flexShrink: 0,
              }}
            />
          </Tooltip>
        </div>
        {trustBadge}
      </Space>
      <Space style={{ flexShrink: 0 }}>
        {artifact?.url && (
          <Button href={artifact.url} target="_blank" rel="noopener noreferrer">
            Open board link
          </Button>
        )}
        <Button icon={<ReloadOutlined />} onClick={onReload} loading={loading}>
          Reload
        </Button>
        <ThemeSwitcher />
        <GlobalUserMenu
          user={currentUser}
          onUserSettingsClick={onUserSettingsClick}
          onLogout={onLogout}
        />
      </Space>
    </Header>
  );
}

export function ArtifactFullscreenPage({
  client,
  currentUser,
  onUserSettingsClick,
  onLogout,
}: ArtifactFullscreenPageProps) {
  const { token } = theme.useToken();
  const { artifactShortId } = useParams();
  const [searchParams, setSearchParams] = useSearchParams();
  const showNavbar =
    searchParams.get('show_navbar') !== 'false' &&
    searchParams.get('chrome') !== '0' &&
    searchParams.get('navbar') !== '0';
  const [artifact, setArtifact] = useState<Artifact | null>(null);
  const [payload, setPayload] = useState<ArtifactPayload | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [consentOpen, setConsentOpen] = useState(false);
  const lastHashRef = useRef<string | null>(null);

  const artifactIdParam = artifactShortId ?? '';

  const fetchArtifact = useCallback(async () => {
    if (!artifactIdParam) return;
    try {
      setLoading(true);
      setError(null);
      const payloadResponse = await fetch(
        `${getDaemonUrl()}/artifacts/${artifactIdParam}/payload`,
        {
          headers: getAuthHeaders(),
        }
      );
      if (!payloadResponse.ok) {
        throw new Error(`Failed to load artifact: ${payloadResponse.statusText}`);
      }
      const nextPayload = (await payloadResponse.json()) as ArtifactPayload;
      setPayload(nextPayload);
      if (client) {
        try {
          const metadata = await client.service('artifacts').get(nextPayload.artifact_id);
          setArtifact(metadata as Artifact);
        } catch {
          // Metadata only powers the optional "back to board" link; payload
          // access is the authoritative visibility/trust check for rendering.
          setArtifact(null);
        }
      }
      lastHashRef.current = nextPayload.content_hash;
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, [artifactIdParam, client]);

  useEffect(() => {
    fetchArtifact();
  }, [fetchArtifact]);

  // Lightweight equivalent of useAgorData's artifact runtime bridge wiring.
  // The fullscreen surface intentionally does not hydrate Workspace data, but
  // MCP DOM-query tools still need the artifacts service event forwarded to
  // the Sandpack iframe bridge when this tab is the active viewer.
  useEffect(() => {
    if (!client) return;
    const service = client.service('artifacts');
    const handleAgorQuery = (event: unknown) => {
      window.dispatchEvent(new CustomEvent('agor:artifact-runtime-query', { detail: event }));
    };
    service.on('agor-query', handleAgorQuery);
    return () => {
      service.removeListener('agor-query', handleAgorQuery);
    };
  }, [client]);

  useEffect(() => {
    if (!client) return;
    const service = client.service('artifacts');
    const handler = (updated: Artifact) => {
      const currentId = payload?.artifact_id ?? artifact?.artifact_id;
      if (!currentId || updated.artifact_id !== currentId) return;
      setArtifact(updated);
      if (updated.content_hash && updated.content_hash !== lastHashRef.current) {
        fetchArtifact();
      }
    };
    service.on('patched', handler);
    service.on('updated', handler);
    return () => {
      service.removeListener('patched', handler);
      service.removeListener('updated', handler);
    };
  }, [artifact?.artifact_id, client, fetchArtifact, payload?.artifact_id]);

  const sandpackConfig = payload?.sandpack_config ?? {};
  const sandpackOptions = sandpackConfig.options ?? {};
  const customSetup = payload
    ? {
        ...(sandpackConfig.customSetup ?? {}),
        ...(payload.dependencies && !sandpackConfig.customSetup?.dependencies
          ? { dependencies: payload.dependencies }
          : {}),
      }
    : {};
  const sandpackTemplate = (sandpackConfig.template ?? payload?.template ?? 'react') as 'react';
  const title = payload?.name ?? artifact?.name ?? `Artifact ${artifactIdParam}`;

  const hideNavbar = useCallback(() => {
    const next = new URLSearchParams(searchParams);
    next.set('show_navbar', 'false');
    next.delete('chrome');
    next.delete('navbar');
    setSearchParams(next, { replace: true });
  }, [searchParams, setSearchParams]);

  const showNavbarAgain = useCallback(() => {
    const next = new URLSearchParams(searchParams);
    next.delete('show_navbar');
    next.delete('chrome');
    next.delete('navbar');
    setSearchParams(next, { replace: true });
  }, [searchParams, setSearchParams]);

  const body = (() => {
    if (loading && !payload) {
      return <Spin size="large" tip="Loading artifact..." />;
    }
    if (error) {
      return (
        <Alert
          type="error"
          showIcon
          title="Failed to load artifact"
          description={error}
          action={<Button onClick={fetchArtifact}>Retry</Button>}
        />
      );
    }
    if (!payload) return null;
    return (
      <div style={{ height: '100%', width: '100%', display: 'flex', flexDirection: 'column' }}>
        {payload.legacy?.is_legacy && (
          <Alert
            type="warning"
            showIcon
            icon={<WarningOutlined />}
            message="Legacy artifact — may not render correctly"
            description="Open the board artifact card for the copyable upgrade prompt."
            style={{ borderRadius: 0 }}
          />
        )}
        <style>{`
          .artifact-fullscreen-sandpack .sp-wrapper,
          .artifact-fullscreen-sandpack .sp-layout,
          .artifact-fullscreen-sandpack .sp-stack,
          .artifact-fullscreen-sandpack .sp-preview,
          .artifact-fullscreen-sandpack .sp-preview-container {
            height: 100% !important;
          }
        `}</style>
        <div className="artifact-fullscreen-sandpack" style={{ flex: 1, minHeight: 0 }}>
          <SandpackProvider
            key={payload.content_hash}
            template={sandpackTemplate}
            files={withBodyReset(payload.files)}
            customSetup={
              Object.keys(customSetup).length > 0 ? (customSetup as SandpackSetup) : undefined
            }
            theme={sandpackConfig.theme as never}
            options={{
              initMode: 'user-visible',
              ...sandpackOptions,
              ...(payload.entry && !sandpackOptions.activeFile
                ? { activeFile: payload.entry }
                : {}),
            }}
          >
            <SandpackPreview
              style={{ height: '100%', border: 'none' }}
              showNavigator={false}
              showOpenInCodeSandbox={false}
              showRefreshButton
            />
            <ArtifactConsoleReporter artifactId={payload.artifact_id} />
            <ArtifactSandpackErrorReporter artifactId={payload.artifact_id} />
            <ArtifactRuntimeBridge artifactId={payload.artifact_id} />
          </SandpackProvider>
        </div>
      </div>
    );
  })();

  return (
    <Layout style={{ minHeight: '100vh', background: token.colorBgLayout }}>
      {showNavbar ? (
        <ArtifactFullscreenNavbar
          artifact={artifact}
          payload={payload}
          title={title}
          loading={loading}
          currentUser={currentUser}
          onReload={fetchArtifact}
          onTrustClick={() => setConsentOpen(true)}
          onHideNavbar={hideNavbar}
          onUserSettingsClick={onUserSettingsClick}
          onLogout={onLogout}
        />
      ) : (
        <Button
          size="small"
          onClick={showNavbarAgain}
          style={{ position: 'fixed', top: 12, right: 12, zIndex: 10 }}
        >
          Show navbar
        </Button>
      )}
      <Content
        style={{
          height: showNavbar ? 'calc(100vh - 56px)' : '100vh',
          display: 'flex',
          alignItems: loading && !payload ? 'center' : 'stretch',
          justifyContent: loading && !payload ? 'center' : 'stretch',
          overflow: 'hidden',
          background: token.colorBgContainer,
        }}
      >
        {body}
      </Content>
      {payload && consentOpen && (
        <ArtifactConsentModal
          open={consentOpen}
          artifactId={payload.artifact_id}
          name={payload.name}
          files={payload.files}
          requiredEnvVars={payload.required_env_vars ?? []}
          grants={payload.agor_grants ?? {}}
          onClose={() => setConsentOpen(false)}
          onGranted={() => {
            setConsentOpen(false);
            fetchArtifact();
          }}
        />
      )}
    </Layout>
  );
}
