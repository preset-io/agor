import {
  PROMPT_PROVENANCE_CLOSE_TAG,
  PROMPT_PROVENANCE_OPEN_TAG,
  stripPromptProvenanceBlock,
} from '@agor/core/templates/prompt-provenance';
import { type Message, type SessionID, sessionPath, shortId } from '@agor-live/client';
import { Collapse, Typography, theme } from 'antd';
import { uiRouteHref } from '../../utils/uiRoutes';

interface Provenance {
  block: string;
  sessionId?: SessionID;
  agenticTool?: string;
  tool?: string;
  mode?: string;
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
      agenticTool: metadata.origin_agentic_tool,
      tool: metadata.tool,
      mode: metadata.mode,
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
  const details = lines.find((line) => line.includes(' · auth: '))?.split(' · ') ?? [];
  const via = details.find((field) => field.startsWith('via '))?.slice('via '.length);
  return {
    block,
    sessionId,
    agenticTool: details
      .find((field) => field.startsWith('agent tool '))
      ?.slice('agent tool '.length),
    tool: via?.split(' (')[0],
    mode: via?.includes(' (') ? via.split(' (')[1]?.slice(0, -1) : undefined,
  };
}

export function PromptProvenance({ provenance }: { provenance: Provenance }) {
  const { token } = theme.useToken();
  return (
    <Collapse
      ghost
      size="small"
      style={{ color: token.colorTextSecondary, fontSize: token.fontSizeSM }}
      items={[
        {
          key: 'provenance',
          label: (
            <Typography.Text type="secondary" style={{ fontSize: token.fontSizeSM }}>
              {provenance.sessionId ? (
                <>
                  from session{' '}
                  <Typography.Link
                    href={uiRouteHref(sessionPath(provenance.sessionId))}
                    onClick={(event) => event.stopPropagation()}
                    onKeyDown={(event) => event.stopPropagation()}
                  >
                    {shortId(provenance.sessionId)}
                  </Typography.Link>
                </>
              ) : (
                'origin not established'
              )}
              {provenance.agenticTool && ` · ${provenance.agenticTool}`}
              {provenance.tool &&
                ` · via ${provenance.tool}${provenance.mode ? ` (${provenance.mode})` : ''}`}
              {' · what the agent saw'}
            </Typography.Text>
          ),
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
  );
}
