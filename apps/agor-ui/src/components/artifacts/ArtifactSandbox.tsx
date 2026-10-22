import type { AgorClient, Artifact, ArtifactPayload, SandpackTemplate } from '@agor-live/client';
import {
  type SandpackPredefinedTemplate,
  SandpackPreview,
  SandpackProvider,
  type SandpackSetup,
} from '@codesandbox/sandpack-react';
import { Spin, theme } from 'antd';
import { useCallback, useEffect, useRef, useState } from 'react';
import { ArtifactRuntimeReporting } from '@/components/artifacts/ArtifactRenderSupport';
import { ensureSandpackCryptoSubtle } from '@/utils/sandpackCrypto';
import { ArtifactConsentModal } from '../ArtifactConsentModal/ArtifactConsentModal';
import {
  ArtifactLegacyNotice,
  ArtifactLoadErrorNotice,
} from '../SessionCanvas/canvas/ArtifactNotices';
import {
  type ArtifactLoadFailure,
  fetchArtifactPayload,
} from '../SessionCanvas/canvas/artifactLoadError';
import { useStableSandpackProviderInputs } from '../SessionCanvas/canvas/utils/sandpackDefaults';

ensureSandpackCryptoSubtle();

export interface ArtifactSandboxState {
  artifact: Artifact | null;
  payload: ArtifactPayload | null;
  loading: boolean;
  error: ArtifactLoadFailure | null;
  reload: () => Promise<void>;
  consentOpen: boolean;
  setConsentOpen: (open: boolean) => void;
}

/**
 * One artifact, live: its payload (the visibility and trust check), its
 * metadata, and a reload whenever its content changes. Shared by the full
 * screen artifact page and the board's preview pane.
 *
 * `forwardRuntimeQueries` relays agent DOM queries to the sandbox. Only a
 * surface without `useAgorData` (the full screen page) needs it; inside the app
 * the data layer already relays them, and relaying twice would run each query twice.
 */
export function useArtifactSandbox(
  client: AgorClient | null,
  artifactId: string,
  { forwardRuntimeQueries = false }: { forwardRuntimeQueries?: boolean } = {}
): ArtifactSandboxState {
  const [artifact, setArtifact] = useState<Artifact | null>(null);
  const [payload, setPayload] = useState<ArtifactPayload | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<ArtifactLoadFailure | null>(null);
  const [consentOpen, setConsentOpen] = useState(false);
  const lastHashRef = useRef<string | null>(null);

  const reload = useCallback(async () => {
    if (!artifactId) return;
    setLoading(true);
    setError(null);
    const result = await fetchArtifactPayload(artifactId);
    if (result.failure) {
      setError(result.failure);
      setLoading(false);
      return;
    }
    const nextPayload = result.payload;
    setPayload(nextPayload);
    if (client) {
      try {
        const metadata = await client.service('artifacts').get(nextPayload.artifact_id);
        setArtifact(metadata as Artifact);
      } catch {
        // Metadata only powers optional links; payload access is the
        // authoritative visibility/trust check for rendering.
        setArtifact(null);
      }
    }
    lastHashRef.current = nextPayload.content_hash;
    setLoading(false);
  }, [artifactId, client]);

  useEffect(() => {
    reload();
  }, [reload]);

  useEffect(() => {
    if (!client || !forwardRuntimeQueries) return;
    const service = client.service('artifacts');
    const handleAgorQuery = (event: unknown) => {
      window.dispatchEvent(new CustomEvent('agor:artifact-runtime-query', { detail: event }));
    };
    service.on('agor-query', handleAgorQuery);
    return () => {
      service.removeListener('agor-query', handleAgorQuery);
    };
  }, [client, forwardRuntimeQueries]);

  useEffect(() => {
    if (!client) return;
    const service = client.service('artifacts');
    const handler = (updated: Artifact) => {
      const currentId = payload?.artifact_id ?? artifact?.artifact_id;
      if (!currentId || updated.artifact_id !== currentId) return;
      setArtifact(updated);
      if (updated.content_hash && updated.content_hash !== lastHashRef.current) {
        reload();
      }
    };
    service.on('patched', handler);
    service.on('updated', handler);
    return () => {
      service.removeListener('patched', handler);
      service.removeListener('updated', handler);
    };
  }, [artifact?.artifact_id, client, reload, payload?.artifact_id]);

  return { artifact, payload, loading, error, reload, consentOpen, setConsentOpen };
}

/** The artifact's Sandpack preview, its load and error states, and its trust consent. */
export function ArtifactSandbox({ sandbox }: { sandbox: ArtifactSandboxState }) {
  const { token } = theme.useToken();
  const { payload, loading, error, reload, consentOpen, setConsentOpen } = sandbox;
  const sandpackConfig = payload?.sandpack_config ?? {};
  const sandpackOptions = sandpackConfig.options ?? {};
  const sandpackTemplate = (sandpackConfig.template ??
    payload?.template ??
    'react') as SandpackTemplate;
  const sandpackInputs = useStableSandpackProviderInputs({
    template: sandpackTemplate,
    files: payload?.files ?? {},
    customSetup: sandpackConfig.customSetup,
    dependencies: payload?.dependencies,
    entryFile: payload?.entry,
    options: sandpackOptions,
  });

  const body = (() => {
    if (loading && !payload) {
      return <Spin size="large" description="Loading artifact…" />;
    }
    if (error) {
      return (
        <ArtifactLoadErrorNotice
          failure={error}
          onRetry={reload}
          style={{ alignSelf: 'flex-start', flex: 1, margin: token.sizeMD }}
        />
      );
    }
    if (!payload) return null;
    return (
      <div style={{ height: '100%', width: '100%', display: 'flex', flexDirection: 'column' }}>
        {payload.legacy?.is_legacy && (
          <ArtifactLegacyNotice
            upgradeInstructions={payload.legacy.upgrade_instructions}
            style={{ borderRadius: 0, flexShrink: 0, maxHeight: '50%', overflowY: 'auto' }}
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
            // The shared artifact union includes legacy `vue3`; Sandpack's
            // provider type is narrower than the persisted compatibility set.
            template={sandpackInputs.template as SandpackPredefinedTemplate}
            files={sandpackInputs.files}
            customSetup={sandpackInputs.customSetup as SandpackSetup | undefined}
            theme={sandpackConfig.theme as never}
            options={sandpackInputs.options}
          >
            <SandpackPreview
              style={{ height: '100%', border: 'none' }}
              showNavigator={false}
              showOpenInCodeSandbox={false}
              showRefreshButton
            />
            {/* On screen: this copy reports, not the board card kept hidden behind it. */}
            <ArtifactRuntimeReporting
              artifactId={payload.artifact_id}
              contentHash={payload.runtime_report_hash ?? payload.content_hash}
              claim
            />
          </SandpackProvider>
        </div>
      </div>
    );
  })();

  return (
    <>
      {body}
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
            reload();
          }}
        />
      )}
    </>
  );
}
