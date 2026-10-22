import type { AgorClient, Artifact, ArtifactPayload, SessionID, User } from '@agor-live/client';
import { sessionPath } from '@agor-live/client';
import {
  ArrowLeftOutlined,
  EyeInvisibleOutlined,
  MessageOutlined,
  ReloadOutlined,
} from '@ant-design/icons';
import { Button, Layout, Space, Tooltip, Typography, theme } from 'antd';
import { useCallback } from 'react';
import { useParams, useSearchParams } from 'react-router-dom';
import { ArtifactTrustStatusIcon } from '@/components/artifacts/ArtifactRenderSupport';
import { ArtifactSandbox, useArtifactSandbox } from '@/components/artifacts/ArtifactSandbox';
import { uiRouteHref } from '@/utils/uiRoutes';
import { BrandLogo } from '../components/BrandLogo';
import { GlobalUserMenu } from '../components/GlobalUserMenu';
import { useMobileBack } from '../components/mobile/useMobileBack';
import { ThemeSwitcher } from '../components/ThemeSwitcher';

const { Header, Content } = Layout;
const { Title } = Typography;

interface ArtifactFullscreenPageProps {
  client: AgorClient | null;
  currentUser?: User | null;
  onUserSettingsClick?: () => void;
  onLogout?: () => void;
  externalAppLink?: string;
  externalAppLabel?: string;
}

interface ArtifactFullscreenNavbarProps {
  artifact: Artifact | null;
  payload: ArtifactPayload | null;
  title: string;
  loading: boolean;
  currentUser?: User | null;
  /** When set, the left control is an in-app Back to the mobile shell. */
  onBackToShell?: () => void;
  onReload: () => void;
  onTrustClick: () => void;
  onHideNavbar: () => void;
  onUserSettingsClick?: () => void;
  onLogout?: () => void;
  externalAppLink?: string;
  externalAppLabel?: string;
}

function ArtifactFullscreenNavbar({
  artifact,
  payload,
  title,
  loading,
  currentUser,
  onBackToShell,
  onReload,
  onTrustClick,
  onHideNavbar,
  onUserSettingsClick,
  onLogout,
  externalAppLink,
  externalAppLabel,
}: ArtifactFullscreenNavbarProps) {
  const { token } = theme.useToken();
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
        {onBackToShell ? (
          <Button type="text" icon={<ArrowLeftOutlined />} onClick={onBackToShell}>
            Back
          </Button>
        ) : (
          <Button
            type="text"
            icon={<ArrowLeftOutlined />}
            href={artifact?.url ?? undefined}
            disabled={!artifact?.url}
          >
            Board
          </Button>
        )}
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
          {payload && <ArtifactTrustStatusIcon payload={payload} onTrustClick={onTrustClick} />}
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
      </Space>
      <Space style={{ flexShrink: 0 }}>
        {(payload?.source_session_id || artifact?.source_session_id) && (
          <Tooltip title="Open session that created this artifact">
            <Button
              icon={<MessageOutlined />}
              href={uiRouteHref(
                sessionPath(
                  (payload?.source_session_id ?? artifact?.source_session_id) as SessionID
                )
              )}
              target="_blank"
              rel="noopener noreferrer"
            >
              Session
            </Button>
          </Tooltip>
        )}
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
          externalAppLink={externalAppLink}
          externalAppLabel={externalAppLabel}
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
  externalAppLink,
  externalAppLabel,
}: ArtifactFullscreenPageProps) {
  const { token } = theme.useToken();
  const { artifactShortId } = useParams();
  const [searchParams, setSearchParams] = useSearchParams();
  // Opened from the mobile shell (?from=m): the left control returns into /m via
  // history rather than the desktop board link, which has no /m equivalent.
  const cameFromMobileShell = searchParams.get('from') === 'm';
  const onBackToShell = useMobileBack('/m');
  const showNavbar =
    searchParams.get('show_navbar') !== 'false' &&
    searchParams.get('chrome') !== '0' &&
    searchParams.get('navbar') !== '0';
  const artifactIdParam = artifactShortId ?? '';
  // This page has no useAgorData, so it relays agent DOM queries itself.
  const sandbox = useArtifactSandbox(client, artifactIdParam, { forwardRuntimeQueries: true });
  const { artifact, payload, loading } = sandbox;
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

  return (
    <Layout style={{ minHeight: '100vh', background: token.colorBgLayout }}>
      {showNavbar ? (
        <ArtifactFullscreenNavbar
          artifact={artifact}
          payload={payload}
          title={title}
          loading={loading}
          currentUser={currentUser}
          onBackToShell={cameFromMobileShell ? onBackToShell : undefined}
          onReload={sandbox.reload}
          onTrustClick={() => sandbox.setConsentOpen(true)}
          onHideNavbar={hideNavbar}
          onUserSettingsClick={onUserSettingsClick}
          onLogout={onLogout}
          externalAppLink={externalAppLink}
          externalAppLabel={externalAppLabel}
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
        <ArtifactSandbox sandbox={sandbox} />
      </Content>
    </Layout>
  );
}
