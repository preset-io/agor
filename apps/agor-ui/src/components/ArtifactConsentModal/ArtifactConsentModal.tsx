/**
 * ArtifactConsentModal — TOFU consent flow for artifact secret/grant injection.
 *
 * Surfaces when the viewer clicks "Render with secrets" on an untrusted
 * artifact. Reuses `FileCollection` for source-code review (so the user can
 * read what they're about to feed secrets to) and presents the requested
 * env vars + grants with severity coding before they choose a trust scope.
 *
 * Scopes:
 *  - just-once     → in-memory session grant (cleared on daemon restart)
 *  - this-artifact → DB-backed; only this artifact ID
 * Both choices are bound to the exact render-affecting artifact hash. Secret
 * consent and agent/LLM introspection consent are independent decisions.
 *
 */

import type { AgorGrants, ArtifactTrustScopeType } from '@agor-live/client';
import { LockOutlined, SafetyCertificateOutlined, WarningOutlined } from '@ant-design/icons';
import { Alert, Button, Card, Checkbox, Modal, Radio, Space, Tag, Typography } from 'antd';
import type { ReactNode } from 'react';
import { useMemo, useState } from 'react';
import { ThemedSyntaxHighlighter } from '@/components/ThemedSyntaxHighlighter';
import { getDaemonUrl } from '@/config/daemon';
import { getAuthHeaders } from '@/utils/authHeaders';
import { getLanguageFromPath } from '@/utils/language';
import { useThemedMessage } from '@/utils/message';
import { FileCollection, type FileItem } from '../FileCollection/FileCollection';

interface ArtifactConsentModalProps {
  open: boolean;
  artifactId: string;
  name: string;
  files: Record<string, string>;
  requiredEnvVars: string[];
  grants: AgorGrants;
  /**
   * Force-hide the "instance-wide" scope option. Defaults to undefined; when
   * left unset, the modal hides instance scope automatically on multi-user
   * Unix isolation modes (read from `/health` features.multiUser).
   */
  onClose: () => void;
  onGranted: () => void;
}

export function ArtifactConsentModal({
  open,
  artifactId,
  name,
  files,
  requiredEnvVars,
  grants,
  onClose,
  onGranted,
}: ArtifactConsentModalProps) {
  const { showSuccess, showError } = useThemedMessage();
  const [scope, setScope] = useState<ArtifactTrustScopeType>('artifact');
  const [allowIntrospection, setAllowIntrospection] = useState(false);
  const [activeFile, setActiveFile] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const fileItems: FileItem[] = useMemo(
    () =>
      Object.entries(files).map(([path, content]) => ({
        path: path.startsWith('/') ? path.slice(1) : path,
        title: path.split('/').pop() ?? path,
        size: content.length,
        lastModified: new Date(0).toISOString(),
        isText: true,
      })),
    [files]
  );

  const grantBadges = renderGrantBadges(grants);

  const submit = async () => {
    setSubmitting(true);
    try {
      const res = await fetch(`${getDaemonUrl()}/artifacts/${artifactId}/trust`, {
        method: 'POST',
        headers: getAuthHeaders(),
        // The server derives the consent surface (env vars + grants) from
        // the artifact itself; the client only nominates the scope.
        body: JSON.stringify({ scopeType: scope, allowIntrospection }),
      });
      if (!res.ok) {
        const detail = await res.text().catch(() => '');
        showError(`Failed to grant trust: ${res.statusText} ${detail}`);
        return;
      }
      showSuccess('Trust granted');
      onGranted();
    } catch (err) {
      showError(`Failed to grant trust: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Modal
      title={
        <span>
          <SafetyCertificateOutlined style={{ marginRight: 8 }} />
          Trust “{name}” to render with secrets
        </span>
      }
      open={open}
      onCancel={onClose}
      width={920}
      footer={null}
      destroyOnHidden
    >
      <Alert
        type="warning"
        showIcon
        icon={<WarningOutlined />}
        style={{ marginBottom: 16 }}
        title="Read the source before granting trust"
        description="Granting trust injects your env-var values and requested daemon capabilities into this exact reviewed artifact version. The artifact can read and exfiltrate them. Any change invalidates this consent."
      />

      <div
        style={{
          display: 'grid',
          gridTemplateColumns: 'minmax(0, 1fr) minmax(0, 2fr)',
          gap: 16,
        }}
      >
        <Card size="small" title="Files in this artifact" styles={{ body: { padding: 0 } }}>
          <div style={{ maxHeight: 360, overflow: 'auto' }}>
            <FileCollection
              files={fileItems}
              onFileClick={(file) => setActiveFile(`/${file.path}`)}
              emptyMessage="No files in this artifact"
            />
          </div>
        </Card>

        <Card
          size="small"
          title={activeFile ? `Preview: ${activeFile}` : 'Pick a file to preview'}
          // The Card is in a 1fr-2fr grid, so it claims its share of the
          // 920px modal even when the file's longest line is wider; the
          // `minmax(0, …)` columns above + the inner `minWidth: 0` here
          // are what stop a long source line from blowing out the grid.
          styles={{ body: { padding: 0, minWidth: 0 } }}
        >
          <div style={{ maxHeight: 360, overflow: 'auto' }}>
            {activeFile ? (
              <ThemedSyntaxHighlighter
                language={getLanguageFromPath(activeFile)}
                showLineNumbers
                customStyle={{
                  margin: 0,
                  borderRadius: 0,
                  fontSize: 12,
                  // The outer wrapper handles vertical scroll — let the
                  // highlighter scroll horizontally on its own line.
                  maxHeight: 'none',
                }}
              >
                {files[activeFile] ?? '(file is empty)'}
              </ThemedSyntaxHighlighter>
            ) : (
              <div style={{ padding: 12, fontSize: 12, opacity: 0.6 }}>
                Click a file on the left to preview it.
              </div>
            )}
          </div>
        </Card>
      </div>

      <div style={{ marginTop: 16 }}>
        <Typography.Title level={5} style={{ marginBottom: 8 }}>
          Requested env vars
        </Typography.Title>
        <Space size={[4, 4]} wrap>
          {requiredEnvVars.length === 0 && (
            <Typography.Text type="secondary">(none)</Typography.Text>
          )}
          {requiredEnvVars.map((v) => (
            <Tag key={v} icon={<LockOutlined />} color="gold">
              {v}
            </Tag>
          ))}
        </Space>
      </div>

      <div style={{ marginTop: 16 }}>
        <Typography.Title level={5} style={{ marginBottom: 8 }}>
          Daemon capabilities
        </Typography.Title>
        <Space size={[4, 4]} wrap>
          {grantBadges.length === 0 && <Typography.Text type="secondary">(none)</Typography.Text>}
          {grantBadges}
        </Space>
      </div>

      <div style={{ marginTop: 16 }}>
        <Typography.Title level={5} style={{ marginBottom: 8 }}>
          Trust scope
        </Typography.Title>
        <Radio.Group value={scope} onChange={(e) => setScope(e.target.value)}>
          <Space orientation="vertical">
            <Radio value="session">Just once (in-memory; cleared when daemon restarts)</Radio>
            <Radio value="artifact">This artifact only</Radio>
          </Space>
        </Radio.Group>
      </div>

      <Alert
        type="info"
        style={{ marginTop: 16 }}
        title="Agent introspection is a separate permission"
        description={
          <Checkbox
            checked={allowIntrospection}
            onChange={(event) => setAllowIntrospection(event.target.checked)}
          >
            Allow DOM and page output from this secret-bearing render to enter agent/LLM context
          </Checkbox>
        }
      />

      <div style={{ marginTop: 24, display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
        <Button onClick={onClose}>Render without secrets</Button>
        <Button type="primary" loading={submitting} onClick={submit}>
          Render with secrets
        </Button>
      </div>
    </Modal>
  );
}

function renderGrantBadges(grants: AgorGrants): ReactNode[] {
  const out: ReactNode[] = [];
  for (const [key, value] of Object.entries(grants)) {
    if (value !== true) continue;
    out.push(
      <Tag key={key} color="blue">
        {key}
      </Tag>
    );
  }
  return out;
}
