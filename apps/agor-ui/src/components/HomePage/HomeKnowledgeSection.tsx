import type { AgorClient, KnowledgeNamespace } from '@agor-live/client';
import { Button, Flex, Input, theme } from 'antd';
import { memo, useCallback, useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { getTimeMs } from '../../utils/entityTime';
import { buildKnowledgeRoutePath } from '../../utils/knowledgeRoutes';
import { HomeCard, HomeLink, HomeSection, HomeSectionError } from './HomeSection';

const HOME_KNOWLEDGE_SPACES = 5;
// Personal and assistant-memory spaces stay out of Home's shortcuts.
const SHARED_KINDS = new Set<KnowledgeNamespace['kind']>(['global', 'team', 'repo']);

export const pickSpaces = (spaces: KnowledgeNamespace[]) =>
  spaces
    .filter((space) => SHARED_KINDS.has(space.kind))
    .sort((a, b) => (getTimeMs(b, 'updated_at') || 0) - (getTimeMs(a, 'updated_at') || 0))
    .slice(0, HOME_KNOWLEDGE_SPACES);

/** Knowledge behind search plus a few spaces; the full list lives on /knowledge. */
export const HomeKnowledgeSection = memo(function HomeKnowledgeSection({
  client,
  connected,
}: {
  client: AgorClient | null;
  connected?: boolean;
}) {
  const { token } = theme.useToken();
  const navigate = useNavigate();
  const [spaces, setSpaces] = useState<KnowledgeNamespace[]>([]);
  const [failed, setFailed] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const retry = useCallback(() => setAttempt((n) => n + 1), []);

  // biome-ignore lint/correctness/useExhaustiveDependencies: `attempt` re-runs the load on retry
  useEffect(() => {
    if (!client || !connected) return;
    let cancelled = false;
    setFailed(false);
    client
      .service('kb/namespaces')
      .find({ query: { archived: false } })
      .then((result) => {
        const rows = Array.isArray(result)
          ? result
          : ((result as { data?: KnowledgeNamespace[] }).data ?? []);
        if (!cancelled) setSpaces(pickSpaces(rows));
      })
      .catch(() => {
        if (!cancelled) setFailed(true);
      });
    return () => {
      cancelled = true;
    };
  }, [client, connected, attempt]);

  return (
    <HomeSection
      id="knowledge"
      title="Knowledge"
      extra={<HomeLink onClick={() => navigate('/knowledge')}>Browse knowledge</HomeLink>}
    >
      <HomeCard padded>
        <Flex vertical gap={token.marginSM}>
          <Input.Search
            allowClear
            placeholder="Search docs and specs"
            aria-label="Search knowledge"
            onSearch={(q) =>
              q.trim() && navigate(`/knowledge?${new URLSearchParams({ q: q.trim() })}`)
            }
          />
          {failed ? (
            <HomeSectionError message="Couldn’t load knowledge spaces." onRetry={retry} />
          ) : (
            spaces.length > 0 && (
              <Flex gap={token.marginXS} wrap>
                {spaces.map((space) => (
                  <Button
                    key={space.namespace_id}
                    size="small"
                    onClick={() => navigate(buildKnowledgeRoutePath('/knowledge', space.slug))}
                  >
                    {space.display_name}
                  </Button>
                ))}
              </Flex>
            )
          )}
        </Flex>
      </HomeCard>
    </HomeSection>
  );
});
