import { ENVIRONMENT } from '@agor/core/config/browser';
import { Alert } from 'antd';
import { type Components, Streamdown } from 'streamdown';

const ELEMENTS = ['p', 'em', 'strong', 'ul', 'ol', 'li', 'a'];

function documentationUrl(value: string | undefined): string | undefined {
  if (!value || !/^https?:\/\//i.test(value)) return undefined;
  try {
    const url = new URL(value);
    if (url.username || url.password) return undefined;
    return url.href;
  } catch {
    return undefined;
  }
}

// Use the existing Markdown engine, not the rich MarkdownRenderer: that
// surface intentionally enables HTML, attachments, diagrams, and controls.
// Plain elements avoid Streamdown's interactive/custom component defaults.
const components: Components = {
  p: 'p',
  em: 'em',
  strong: 'strong',
  ul: 'ul',
  ol: 'ol',
  li: 'li',
  a: ({ href, children }) => {
    const safeUrl = documentationUrl(href);
    return safeUrl ? (
      <a href={safeUrl} target="_blank" rel="noopener noreferrer">
        {children}
      </a>
    ) : (
      children
    );
  },
};

export function EnvironmentDisclaimer({ markdown }: { markdown?: string }) {
  // Defense in depth at the rendering boundary, including old/malformed DTOs.
  if (typeof markdown !== 'string' || !markdown.trim()) return null;
  return (
    <Alert
      type="info"
      showIcon
      role="note"
      aria-label="Environment guidance"
      title="Environment guidance"
      style={{ minWidth: 0, overflowWrap: 'anywhere' }}
      description={
        <Streamdown
          mode="static"
          parseIncompleteMarkdown={false}
          skipHtml
          allowedElements={ELEMENTS}
          remarkPlugins={[]}
          rehypePlugins={[]}
          plugins={{}}
          controls={false}
          components={components}
          urlTransform={(url) => documentationUrl(url)}
        >
          {markdown.slice(0, ENVIRONMENT.DISCLAIMER_MAX_LENGTH)}
        </Streamdown>
      }
    />
  );
}
