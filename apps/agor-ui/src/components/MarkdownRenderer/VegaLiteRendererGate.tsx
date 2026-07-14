import React, { Suspense } from 'react';
import {
  CodeBlock,
  CodeBlockCopyButton,
  CodeBlockSkeleton,
  type CustomRendererProps,
} from 'streamdown';

const LazyVegaLiteRenderer = React.lazy(() =>
  import('./VegaLiteRenderer').then(({ VegaLiteRenderer }) => ({ default: VegaLiteRenderer }))
);

interface VegaLiteErrorBoundaryProps extends CustomRendererProps {
  children: React.ReactNode;
}

interface VegaLiteErrorBoundaryState {
  failed: boolean;
}

class VegaLiteErrorBoundary extends React.Component<
  VegaLiteErrorBoundaryProps,
  VegaLiteErrorBoundaryState
> {
  state: VegaLiteErrorBoundaryState = { failed: false };

  static getDerivedStateFromError(): VegaLiteErrorBoundaryState {
    return { failed: true };
  }

  render() {
    if (this.state.failed) {
      return <VegaLiteCodeFallback {...this.props} />;
    }
    return this.props.children;
  }
}

/**
 * Synchronous renderer registered with Streamdown. The actual chart renderer
 * is not requested until the fence closes, so streaming a partial JSON spec
 * never downloads or repeatedly invokes Vega.
 */
export function VegaLiteRendererGate(props: CustomRendererProps) {
  if (props.isIncomplete) {
    return <VegaLiteCodeFallback {...props} />;
  }

  return (
    <VegaLiteErrorBoundary {...props}>
      <Suspense fallback={<CodeBlockSkeleton />}>
        <LazyVegaLiteRenderer {...props} />
      </Suspense>
    </VegaLiteErrorBoundary>
  );
}

function VegaLiteCodeFallback({ code, isIncomplete, language }: CustomRendererProps) {
  return (
    <CodeBlock code={code} isIncomplete={isIncomplete} language={language} lineNumbers={false}>
      <CodeBlockCopyButton code={code} />
    </CodeBlock>
  );
}
