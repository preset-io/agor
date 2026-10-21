import {
  PROMPT_PROVENANCE_CLOSE_TAG,
  PROMPT_PROVENANCE_OPEN_TAG,
  stripPromptProvenanceBlock,
} from '@agor/core/templates/prompt-provenance';
import { type Message, type SessionID, sessionPath } from '@agor-live/client';
import { Collapse, Flex, Typography, theme } from 'antd';
import { useMemo } from 'react';
import { useAgorStore } from '../../store/agorStore';
import { makeSessionSelector } from '../../store/selectors';
import { getSessionDisplayTitle } from '../../utils/sessionTitle';
import { uiRouteHref } from '../../utils/uiRoutes';

interface Provenance {
  block: string;
  sessionId?: SessionID;
}

function provenanceBlock(text: string): string | undefined {
  const start = text.indexOf(PROMPT_PROVENANCE_OPEN_TAG);
  if (start < 0) return undefined;
  const end = text.indexOf(PROMPT_PROVENANCE_CLOSE_TAG, start);
  return end < 0 ? undefined : text.slice(start, end + PROMPT_PROVENANCE_CLOSE_TAG.length);
}

export function stripProvenanceForDisplay(text: string): string {
  const block = provenanceBlock(text);
  if (!block) return text;
  return text.trim() === block ? '' : stripPromptProvenanceBlock(text);
}

export function getPromptProvenance(message: Message): Provenance | undefined {
  if (message.role !== 'user') return undefined;
  const metadata = message.metadata?.prompt_provenance;
  if (metadata) {
    return {
      block: metadata.rendered_block,
      sessionId: metadata.origin_session_id,
    };
  }

  const text =
    typeof message.content === 'string'
      ? message.content
      : Array.isArray(message.content)
        ? message.content
            .filter((part) => part.type === 'text')
            .map((part) => part.text)
            .join('\n')
        : '';
  const block = provenanceBlock(text);
  if (!block) return undefined;

  // Older rows have only the reserved, server-rendered text projection.
  const lines = block.split('\n');
  const verify = lines.find((line) => line.startsWith('Verify: agor_sessions_get sessionId="'));
  const sessionId = verify?.split('sessionId="')[1]?.split('"')[0] as SessionID | undefined;
  return { block, sessionId };
}

export function PromptProvenance({ provenance }: { provenance: Provenance }) {
  const { token } = theme.useToken();
  const sender = useAgorStore(
    useMemo(() => makeSessionSelector(provenance.sessionId), [provenance.sessionId])
  );
  const senderTitle = sender?.title?.trim() ? getSessionDisplayTitle(sender) : undefined;
  return (
    <Flex vertical gap={token.sizeUnit / 2}>
      <Typography.Text type="secondary" style={{ fontSize: token.fontSizeSM }}>
        Sent by{' '}
        {senderTitle && provenance.sessionId ? (
          <Typography.Link href={uiRouteHref(sessionPath(provenance.sessionId))}>
            {senderTitle}
          </Typography.Link>
        ) : (
          'another session'
        )}
      </Typography.Text>
      <Collapse
        ghost
        size="small"
        style={{ color: token.colorTextSecondary, fontSize: token.fontSizeSM }}
        items={[
          {
            key: 'provenance',
            label: 'Details',
            styles: { header: { padding: 0 }, body: { padding: token.paddingXS } },
            children: (
              <pre
                style={{
                  margin: 0,
                  whiteSpace: 'pre-wrap',
                  overflowWrap: 'anywhere',
                  fontFamily: token.fontFamilyCode,
                }}
              >
                {provenance.block}
              </pre>
            ),
          },
        ]}
      />
    </Flex>
  );
}
