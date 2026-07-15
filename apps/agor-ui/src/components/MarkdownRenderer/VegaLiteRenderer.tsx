import { Alert, Flex, Skeleton, Typography, theme } from 'antd';
import { useContext, useEffect, useMemo, useRef, useState } from 'react';
import {
  CodeBlock,
  CodeBlockContainer,
  CodeBlockCopyButton,
  type CustomRendererProps,
  StreamdownContext,
} from 'streamdown';
import { isDarkTheme } from '../../utils/theme';
import { isCodeCopyEnabled } from './streamdownControls';
import { type ParsedVegaLiteSpec, parseVegaLiteSpec } from './vegaLiteSpec';
import { loadVegaRuntime } from './vegaRuntime';

const RENDER_TIMEOUT_MS = 5_000;

type RenderState =
  | { status: 'loading' }
  | { status: 'ready' }
  | { status: 'error'; message: string };

export function VegaLiteRenderer({ code, language }: CustomRendererProps) {
  const { token } = theme.useToken();
  const { controls } = useContext(StreamdownContext);
  const showCopy = isCodeCopyEnabled(controls);
  const containerRef = useRef<HTMLDivElement>(null);
  const [renderState, setRenderState] = useState<RenderState>({ status: 'loading' });
  const parsed = useMemo<
    { ok: true; value: ParsedVegaLiteSpec } | { ok: false; error: string }
  >(() => {
    try {
      return { ok: true, value: parseVegaLiteSpec(code) };
    } catch (error) {
      return {
        ok: false,
        error: error instanceof Error ? error.message : 'The Vega-Lite spec is invalid.',
      };
    }
  }, [code]);

  useEffect(() => {
    if (!parsed.ok || !containerRef.current) return;

    let disposed = false;
    let view: { finalize: () => void } | undefined;
    let timedOut = false;
    let timeout: number | undefined;
    const element = containerRef.current;

    const render = async () => {
      try {
        // Nested dynamic imports are deliberate. The renderer component itself
        // is lazy, and the multi-megabyte Vega runtime is a second, chart-only
        // chunk that is never requested for ordinary Markdown.
        const { loader, vegaEmbed } = await loadVegaRuntime();
        if (disposed) return;

        // Loading or cold-compiling the lazy Vega chunk can take more than five
        // seconds in the Docker dev server. Start the safety timeout only once
        // the runtime is present so it measures chart work, not network/tooling.
        timeout = window.setTimeout(() => {
          timedOut = true;
          if (!disposed) setRenderState({ status: 'error', message: 'Chart rendering timed out.' });
        }, RENDER_TIMEOUT_MS);

        const noNetworkLoader = loader();
        noNetworkLoader.load = async (uri) => {
          throw new Error(`Remote Vega resource blocked: ${uri}`);
        };
        noNetworkLoader.sanitize = async (uri) => {
          throw new Error(`Remote Vega resource blocked: ${uri}`);
        };

        const result = await vegaEmbed(element, parsed.value.spec, {
          actions: false,
          ast: true,
          config: {
            background: 'transparent',
            axis: {
              domainColor: token.colorBorder,
              gridColor: token.colorBorderSecondary,
              labelColor: token.colorText,
              tickColor: token.colorBorder,
              titleColor: token.colorText,
            },
            legend: { labelColor: token.colorText, titleColor: token.colorText },
            title: { color: token.colorText },
          },
          hover: false,
          loader: noNetworkLoader,
          mode: 'vega-lite',
          renderer: 'svg',
          theme: isDarkTheme(token) ? 'dark' : undefined,
          tooltip: false,
        });
        view = result.view;
        if (disposed || timedOut) {
          result.view.finalize();
          return;
        }
        if (timeout !== undefined) window.clearTimeout(timeout);
        setRenderState({ status: 'ready' });
      } catch (error) {
        if (timeout !== undefined) window.clearTimeout(timeout);
        if (!disposed && !timedOut) {
          setRenderState({
            status: 'error',
            message:
              error instanceof Error ? error.message : 'Vega-Lite could not render this chart.',
          });
        }
      }
    };

    void render();
    return () => {
      disposed = true;
      if (timeout !== undefined) window.clearTimeout(timeout);
      view?.finalize();
      element.replaceChildren();
    };
  }, [parsed, token]);

  if (!parsed.ok) {
    return <VegaLiteError code={code} language={language} message={parsed.error} />;
  }

  if (renderState.status === 'error') {
    return <VegaLiteError code={code} language={language} message={renderState.message} />;
  }

  return (
    <CodeBlockContainer language={language}>
      <Flex
        align="center"
        data-code-block-header
        justify="space-between"
        style={{
          background: token.colorFillQuaternary,
          borderBottom: `1px solid ${token.colorBorderSecondary}`,
          minHeight: token.controlHeight,
          paddingInline: token.paddingSM,
        }}
      >
        <Typography.Text code>{language}</Typography.Text>
        {showCopy ? <CodeBlockCopyButton aria-label="Copy Vega-Lite spec" code={code} /> : null}
      </Flex>
      <figure
        aria-busy={renderState.status === 'loading'}
        aria-label={parsed.value.description}
        style={{ margin: 0, minHeight: 220, overflowX: 'auto', padding: token.padding }}
      >
        {renderState.status === 'loading' ? (
          <div aria-live="polite">
            <Typography.Text type="secondary">Loading Vega-Lite chart…</Typography.Text>
            <Skeleton active paragraph={{ rows: 4 }} title={false} />
          </div>
        ) : null}
        <div
          ref={containerRef}
          style={{
            visibility: renderState.status === 'ready' ? 'visible' : 'hidden',
            width: '100%',
          }}
        />
      </figure>
      {showCopy ? (
        <details
          style={{ borderTop: `1px solid ${token.colorBorderSecondary}`, padding: token.paddingSM }}
        >
          <summary style={{ cursor: 'pointer' }}>View Vega-Lite source</summary>
          <CodeBlock code={code} language="json" lineNumbers={false}>
            <CodeBlockCopyButton code={code} />
          </CodeBlock>
        </details>
      ) : null}
    </CodeBlockContainer>
  );
}

function VegaLiteError({
  code,
  language,
  message,
}: {
  code: string;
  language: string;
  message: string;
}) {
  const { controls } = useContext(StreamdownContext);
  const showCopy = isCodeCopyEnabled(controls);
  return (
    <Flex gap="small" vertical>
      <Alert
        description="The original fenced block is shown below and remains copyable."
        message={`Vega-Lite chart unavailable: ${message}`}
        role="alert"
        showIcon
        type="warning"
      />
      <CodeBlock code={code} language={language} lineNumbers={false}>
        {showCopy ? <CodeBlockCopyButton code={code} /> : null}
      </CodeBlock>
    </Flex>
  );
}
