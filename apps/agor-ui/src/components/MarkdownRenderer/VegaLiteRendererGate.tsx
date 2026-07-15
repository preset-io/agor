import React, { useContext, useEffect, useId, useRef, useState } from 'react';
import {
  CodeBlock,
  CodeBlockCopyButton,
  type CustomRendererProps,
  StreamdownContext,
} from 'streamdown';
import { isCodeCopyEnabled } from './streamdownControls';
import { VegaLiteActivationBudgetContext } from './vegaLiteActivationBudget';
import { loadVegaRenderer } from './vegaRendererLoader';

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
  const activationBudget = useContext(VegaLiteActivationBudgetContext);
  const activationId = useId();
  const gateRef = useRef<HTMLDivElement>(null);
  const [isNearViewport, setIsNearViewport] = useState(
    () => typeof IntersectionObserver === 'undefined'
  );
  const [Renderer, setRenderer] = useState<React.ComponentType<CustomRendererProps> | null>(null);
  const [loadFailed, setLoadFailed] = useState(false);
  const [activationAllowed, setActivationAllowed] = useState(false);

  useEffect(() => {
    setActivationAllowed(
      props.isIncomplete ? false : (activationBudget?.claim(activationId) ?? false)
    );
  }, [activationBudget, activationId, props.isIncomplete]);

  useEffect(() => {
    if (isNearViewport || props.isIncomplete || !activationAllowed || !gateRef.current) return;
    const observer = new IntersectionObserver(
      (entries) => {
        if (!entries.some((entry) => entry.isIntersecting)) return;
        setIsNearViewport(true);
        observer.disconnect();
      },
      { rootMargin: '400px 0px' }
    );
    observer.observe(gateRef.current);
    return () => observer.disconnect();
  }, [activationAllowed, isNearViewport, props.isIncomplete]);

  useEffect(() => {
    if (props.isIncomplete || !activationAllowed || !isNearViewport || Renderer || loadFailed)
      return;
    let disposed = false;
    const load = async () => {
      try {
        const module = await loadVegaRenderer();
        if (!disposed) setRenderer(() => module.VegaLiteRenderer);
      } catch {
        if (!disposed) setLoadFailed(true);
      }
    };
    void load();
    return () => {
      disposed = true;
    };
  }, [Renderer, activationAllowed, isNearViewport, loadFailed, props.isIncomplete]);

  if (props.isIncomplete) {
    return <VegaLiteCodeFallback {...props} />;
  }

  if (!activationAllowed) {
    return <VegaLiteCodeFallback {...props} />;
  }

  if (!Renderer || loadFailed) {
    return (
      <div ref={gateRef}>
        <VegaLiteCodeFallback
          {...props}
          status={
            loadFailed ? 'Chart renderer unavailable; showing source.' : 'Loading chart renderer…'
          }
        />
      </div>
    );
  }

  return (
    <VegaLiteErrorBoundary {...props}>
      <Renderer {...props} />
    </VegaLiteErrorBoundary>
  );
}

function VegaLiteCodeFallback({
  code,
  isIncomplete,
  language,
  status,
}: CustomRendererProps & { status?: string }) {
  const { controls } = useContext(StreamdownContext);
  const showCopy = isCodeCopyEnabled(controls);
  return (
    <CodeBlock code={code} isIncomplete={isIncomplete} language={language} lineNumbers={false}>
      {showCopy ? <CodeBlockCopyButton code={code} /> : null}
      {status ? (
        <span aria-live="polite" className="sr-only">
          {status}
        </span>
      ) : null}
    </CodeBlock>
  );
}
