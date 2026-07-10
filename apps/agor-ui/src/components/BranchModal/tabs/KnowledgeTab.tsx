import type {
  AgorClient,
  Branch,
  KnowledgeNamespace,
  TeammateKnowledgeConfig,
  TeammateKnowledgeGrant,
  TeammateKnowledgeGrantAccess,
} from '@agor-live/client';
import { getTeammateConfig } from '@agor-live/client';
import {
  Alert,
  Button,
  Card,
  Descriptions,
  Empty,
  Select,
  Space,
  Spin,
  Table,
  Tag,
  Typography,
} from 'antd';
import { useEffect, useMemo, useState } from 'react';
import { useThemedMessage } from '@/utils/message';

interface KnowledgeTabProps {
  branch: Branch;
  client: AgorClient | null;
  canEdit: boolean;
}

type EditableGrant = TeammateKnowledgeGrant & { key: string };

const ACCESS_OPTIONS: Array<{ label: string; value: TeammateKnowledgeGrantAccess }> = [
  { label: 'No access', value: 'none' },
  { label: 'Read', value: 'read' },
  { label: 'Write', value: 'write' },
];

const HOME_NAMESPACE_PERMISSIONS = new Set(['write', 'own']);

function emptyKbConfig(): Partial<TeammateKnowledgeConfig> {
  return {
    memory_path_template: 'memory/{{YYYY-MM-DD}}.md',
    default_visibility: 'public',
    global_access: 'write',
    grants: [],
  };
}

function grantKey(grant: Pick<TeammateKnowledgeGrant, 'namespace_id' | 'namespace_slug'>) {
  return grant.namespace_id || grant.namespace_slug;
}

function namespaceSelectLabel(namespace: KnowledgeNamespace) {
  const permission = namespace.effective_permission ?? 'unknown';
  return `${namespace.display_name} (${namespace.slug}) · ${permission}`;
}

export function buildTeammateKnowledgePatch(
  branch: Pick<Branch, 'custom_context'>,
  nextKb: Partial<TeammateKnowledgeConfig>
): Partial<Branch> {
  const existingConfig =
    branch.custom_context?.teammate ??
    branch.custom_context?.assistant ??
    branch.custom_context?.agent ??
    {};
  return {
    custom_context: {
      teammate: {
        ...existingConfig,
        kind: 'teammate',
        kb: nextKb,
      },
    },
  };
}

export const KnowledgeTab: React.FC<KnowledgeTabProps> = ({ branch, client, canEdit }) => {
  const { showSuccess, showError } = useThemedMessage();
  const teammate = useMemo(() => getTeammateConfig(branch), [branch]);
  const initialKb = teammate?.kb;
  const [kb, setKb] = useState<Partial<TeammateKnowledgeConfig>>(initialKb ?? emptyKbConfig());
  const [namespace, setNamespace] = useState<KnowledgeNamespace | null>(null);
  const [namespaces, setNamespaces] = useState<KnowledgeNamespace[]>([]);
  const [loading, setLoading] = useState(false);
  const [repairing, setRepairing] = useState(false);
  const [savingPolicy, setSavingPolicy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setKb(initialKb ?? emptyKbConfig());
  }, [initialKb]);

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      setNamespace(null);
      setError(null);
      if (!client) return;
      setLoading(true);
      try {
        const rows = (await client.service('kb/namespaces').find({
          query: { archived: false, $limit: 1000 },
        })) as KnowledgeNamespace[] | { data?: KnowledgeNamespace[] };
        if (!cancelled) setNamespaces(Array.isArray(rows) ? rows : (rows.data ?? []));

        if (kb.primary_namespace_id) {
          const result = (await client
            .service('kb/namespaces')
            .get(kb.primary_namespace_id)) as KnowledgeNamespace;
          if (!cancelled) setNamespace(result);
        }
      } catch (err) {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err));
      } finally {
        if (!cancelled) setLoading(false);
      }
    };
    void load();
    return () => {
      cancelled = true;
    };
  }, [client, kb.primary_namespace_id]);

  const editableGrants: EditableGrant[] = useMemo(
    () =>
      (kb.grants ?? []).map((grant) => ({
        ...grant,
        key: grantKey(grant),
      })),
    [kb.grants]
  );

  const namespaceById = useMemo(
    () => new Map(namespaces.map((item) => [String(item.namespace_id), item])),
    [namespaces]
  );

  const handleRepair = async () => {
    if (!client) return;
    setRepairing(true);
    setError(null);
    try {
      const result = await client
        .service('branches')
        .ensureTeammateKnowledgeNamespace({ branchId: branch.branch_id });
      setNamespace(result.namespace);
      const nextKb = getTeammateConfig(result.branch)?.kb ?? kb;
      setKb(nextKb);
      showSuccess('Teammate Knowledge namespace is ready');
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      setError(message);
      showError(message);
    } finally {
      setRepairing(false);
    }
  };

  const patchKb = async (nextKb: Partial<TeammateKnowledgeConfig>) => {
    if (!client) return;
    setSavingPolicy(true);
    try {
      const updated = (await client
        .service('branches')
        .patch(branch.branch_id, buildTeammateKnowledgePatch(branch, nextKb))) as Branch;
      const savedKb = getTeammateConfig(updated)?.kb ?? nextKb;
      setKb(savedKb);
      showSuccess('Teammate Knowledge policy saved');
    } catch (err) {
      showError(err instanceof Error ? err.message : String(err));
    } finally {
      setSavingPolicy(false);
    }
  };

  const selectHomeNamespace = (namespaceId: string) => {
    const selected = namespaceById.get(namespaceId);
    if (!selected) return;
    setKb((current) => ({
      ...current,
      primary_namespace_id: selected.namespace_id,
      primary_namespace_slug: selected.slug,
      default_visibility: selected.visibility_default,
      memory_path_template: current.memory_path_template ?? 'memory/{{YYYY-MM-DD}}.md',
    }));
    setNamespace(selected);
  };

  const updateGrant = (key: string, patch: Partial<TeammateKnowledgeGrant>) => {
    setKb((current) => ({
      ...current,
      grants: (current.grants ?? []).map((grant) =>
        grantKey(grant) === key ? { ...grant, ...patch } : grant
      ),
    }));
  };

  const addGrant = (namespaceId: string) => {
    const selected = namespaceById.get(namespaceId);
    if (!selected) return;
    setKb((current) => {
      const grants = current.grants ?? [];
      if (grants.some((grant) => grant.namespace_id === selected.namespace_id)) return current;
      return {
        ...current,
        grants: [
          ...grants,
          {
            namespace_id: selected.namespace_id,
            namespace_slug: selected.slug,
            access: 'read',
          },
        ],
      };
    });
  };

  const removeGrant = (key: string) => {
    setKb((current) => ({
      ...current,
      grants: (current.grants ?? []).filter((grant) => grantKey(grant) !== key),
    }));
  };

  if (!teammate) {
    return <Empty description="Knowledge memory is only available for teammate branches." />;
  }

  const missing = !namespace && (!kb.primary_namespace_id || error);
  const configuredGrantIds = new Set((kb.grants ?? []).map((grant) => grant.namespace_id));
  if (kb.primary_namespace_id) configuredGrantIds.add(kb.primary_namespace_id);

  return (
    <div style={{ padding: 16 }}>
      <Space direction="vertical" size="middle" style={{ width: '100%' }}>
        <Alert
          type="info"
          showIcon
          message="Teammate Knowledge"
          description="Teammate tools always use the home namespace for memory. Beyond that, this policy controls which Knowledge namespaces teammate-specific MCP tools may search. Effective access is still limited by the current user's namespace permissions."
        />

        <Card
          title="Home namespace"
          extra={
            <Space>
              {namespace?.slug && (
                <Button href={`/kb/${encodeURIComponent(namespace.slug)}/`} target="_blank">
                  Open in Knowledge
                </Button>
              )}
              {canEdit && (
                <Button onClick={handleRepair} loading={repairing} disabled={!client}>
                  {kb.primary_namespace_id ? 'Repair namespace' : 'Create namespace'}
                </Button>
              )}
            </Space>
          }
        >
          <Space direction="vertical" size="middle" style={{ width: '100%' }}>
            <Typography.Paragraph type="secondary" style={{ marginBottom: 0 }}>
              The home namespace is where this teammate stores its memory and where
              teammate-specific Knowledge tools start by default. Choose a namespace you can write
              to.
            </Typography.Paragraph>

            {canEdit && (
              <Space.Compact style={{ width: '100%' }}>
                <Select
                  showSearch
                  aria-label="Home Knowledge namespace"
                  placeholder="Select home Knowledge namespace"
                  value={kb.primary_namespace_id}
                  loading={loading}
                  disabled={!client || repairing}
                  optionFilterProp="label"
                  onChange={selectHomeNamespace}
                  style={{ minWidth: 360, flex: 1 }}
                  options={namespaces.map((item) => {
                    const canUseAsHome = HOME_NAMESPACE_PERMISSIONS.has(
                      item.effective_permission ?? 'none'
                    );
                    return {
                      label: namespaceSelectLabel(item),
                      value: item.namespace_id,
                      disabled: !canUseAsHome && item.namespace_id !== kb.primary_namespace_id,
                    };
                  })}
                />
                <Button
                  type="primary"
                  onClick={() => patchKb(kb)}
                  loading={savingPolicy}
                  disabled={!client || !kb.primary_namespace_id}
                >
                  Save home
                </Button>
              </Space.Compact>
            )}

            {loading ? (
              <Spin />
            ) : missing ? (
              <Alert
                type="warning"
                showIcon
                message="Home namespace is missing or unavailable"
                description={error || 'namespace for this agent is not set up'}
              />
            ) : (
              <Descriptions column={1} size="small">
                <Descriptions.Item label="Name">{namespace?.display_name}</Descriptions.Item>
                <Descriptions.Item label="Slug">
                  <Typography.Text code>
                    {namespace?.slug ?? kb.primary_namespace_slug}
                  </Typography.Text>
                </Descriptions.Item>
                <Descriptions.Item label="Your permission">
                  <Tag>{namespace?.effective_permission ?? 'unknown'}</Tag>
                </Descriptions.Item>
                <Descriptions.Item label="Default document visibility">
                  <Tag>{namespace?.visibility_default ?? kb.default_visibility}</Tag>
                </Descriptions.Item>
                <Descriptions.Item label="Others can">
                  <Tag>{namespace?.others_can ?? 'unknown'}</Tag>
                </Descriptions.Item>
                <Descriptions.Item label="Memory path">
                  <Typography.Text code>
                    {kb.memory_path_template ?? 'memory/{{YYYY-MM-DD}}.md'}
                  </Typography.Text>
                </Descriptions.Item>
              </Descriptions>
            )}
          </Space>
        </Card>

        <Card
          title="Teammate Knowledge access"
          extra={
            canEdit ? (
              <Button
                type="primary"
                onClick={() => patchKb(kb)}
                loading={savingPolicy}
                disabled={!client || !kb.primary_namespace_id}
              >
                Save policy
              </Button>
            ) : null
          }
        >
          <Space direction="vertical" size="middle" style={{ width: '100%' }}>
            <div>
              <Typography.Text strong>Entire Knowledge Base fallback</Typography.Text>
              <Typography.Paragraph type="secondary" style={{ marginBottom: 8 }}>
                Applies to any namespace that is not listed below. Choose none for a locked-down
                teammate, read for broad context, or write for teammate tools that may update any
                namespace the current user can write.
              </Typography.Paragraph>
              <Select
                value={kb.global_access ?? 'write'}
                options={ACCESS_OPTIONS}
                disabled={!canEdit}
                style={{ width: 220 }}
                onChange={(value) => setKb((current) => ({ ...current, global_access: value }))}
              />
            </div>

            <div>
              <Typography.Text strong>Per-namespace overrides</Typography.Text>
              <Typography.Paragraph type="secondary" style={{ marginBottom: 8 }}>
                Add namespaces to narrow or expand the fallback policy for specific spaces. The home
                namespace is always available to teammate memory tools.
              </Typography.Paragraph>
              {canEdit && (
                <Select
                  showSearch
                  placeholder="Add namespace override"
                  style={{ minWidth: 320, marginBottom: 12 }}
                  disabled={!client}
                  value={undefined}
                  optionFilterProp="label"
                  onChange={addGrant}
                  options={namespaces
                    .filter((item) => !configuredGrantIds.has(item.namespace_id))
                    .map((item) => ({
                      label: `${item.display_name} (${item.slug})`,
                      value: item.namespace_id,
                    }))}
                />
              )}
              <Table<EditableGrant>
                size="small"
                pagination={false}
                rowKey="key"
                dataSource={editableGrants}
                locale={{ emptyText: 'No per-namespace overrides' }}
                columns={[
                  {
                    title: 'Namespace',
                    dataIndex: 'namespace_slug',
                    render: (_value, grant) => {
                      const row = namespaceById.get(grant.namespace_id);
                      return (
                        <Space direction="vertical" size={0}>
                          <Typography.Text>
                            {row?.display_name ?? grant.namespace_slug}
                          </Typography.Text>
                          <Typography.Text type="secondary" code>
                            {grant.namespace_slug}
                          </Typography.Text>
                        </Space>
                      );
                    },
                  },
                  {
                    title: 'Access',
                    dataIndex: 'access',
                    width: 150,
                    render: (_value, grant) => (
                      <Select
                        value={grant.access}
                        options={ACCESS_OPTIONS}
                        disabled={!canEdit}
                        style={{ width: 130 }}
                        onChange={(access) => updateGrant(grant.key, { access })}
                      />
                    ),
                  },
                  {
                    title: 'Effective now',
                    width: 150,
                    render: (_value, grant) => {
                      const row = namespaceById.get(grant.namespace_id);
                      return <Tag>{row?.effective_permission ?? 'unknown'}</Tag>;
                    },
                  },
                  {
                    title: '',
                    width: 90,
                    render: (_value, grant) =>
                      canEdit ? (
                        <Button type="link" danger onClick={() => removeGrant(grant.key)}>
                          Remove
                        </Button>
                      ) : null,
                  },
                ]}
              />
            </div>
          </Space>
        </Card>
      </Space>
    </div>
  );
};
