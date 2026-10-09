import { Alert } from 'antd';
import { Component, type ErrorInfo, type ReactNode } from 'react';
import { InitialLoadingScreen } from '../InitialLoadingScreen';
import { GlobalCrashScreen } from './GlobalCrashScreen';
import {
  isDynamicImportFailure,
  RELOAD_FALLBACK_MS,
  reloadForStaleChunk,
} from './staleChunkReload';

interface ErrorBoundaryProps {
  children: ReactNode;
  // Visual mode for the fallback.
  //   'scoped' (default): small inline antd <Alert> — good for section-level
  //     boundaries that wrap one piece of UI (e.g. the logs modal).
  //   'global': full-screen friendly crash screen with a copy-paste markdown
  //     report and GitHub issue link — for the top-level boundary around the
  //     entire app.
  variant?: 'scoped' | 'global';
  fallbackTitle?: ReactNode;
  // When this value changes, the boundary clears its error state and re-renders
  // children. Useful when fresh data may unblock the failed render (e.g. a
  // logs refresh after a transient bad payload). The global variant doesn't
  // typically use this — the user reloads instead.
  resetKey?: unknown;
}

interface ErrorBoundaryState {
  error: Error | null;
  errorInfo: ErrorInfo | null;
  resetKey: unknown;
  reloading: boolean;
}

export class ErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  state: ErrorBoundaryState = {
    error: null,
    errorInfo: null,
    resetKey: this.props.resetKey,
    reloading: false,
  };

  private reloadFallbackTimer: ReturnType<typeof setTimeout> | null = null;

  static getDerivedStateFromError(error: Error): Partial<ErrorBoundaryState> {
    return { error };
  }

  static getDerivedStateFromProps(
    props: ErrorBoundaryProps,
    state: ErrorBoundaryState
  ): Partial<ErrorBoundaryState> | null {
    if (props.resetKey !== state.resetKey) {
      return { error: null, errorInfo: null, resetKey: props.resetKey, reloading: false };
    }
    return null;
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    // The app is already lost to the crash screen, so a stale-chunk reload discards nothing more.
    if (
      this.props.variant === 'global' &&
      isDynamicImportFailure(error) &&
      reloadForStaleChunk(error)
    ) {
      console.warn('Reloading after a lazy chunk failed to load:', error.message);
      this.setState({ errorInfo: info, reloading: true });
      if (this.reloadFallbackTimer !== null) clearTimeout(this.reloadFallbackTimer);
      this.reloadFallbackTimer = setTimeout(
        () => this.setState({ reloading: false }),
        RELOAD_FALLBACK_MS
      );
      return;
    }
    console.error('ErrorBoundary caught render error:', error, info.componentStack);
    this.setState({ errorInfo: info });
  }

  componentWillUnmount() {
    if (this.reloadFallbackTimer !== null) clearTimeout(this.reloadFallbackTimer);
  }

  render() {
    const { error, errorInfo, reloading } = this.state;
    const { variant = 'scoped', fallbackTitle, children } = this.props;

    if (error) {
      if (variant === 'global') {
        if (reloading) return <InitialLoadingScreen message="Reloading…" />;
        return <GlobalCrashScreen error={error} errorInfo={errorInfo} />;
      }
      return (
        <Alert
          type="error"
          showIcon
          title={fallbackTitle ?? 'Something went wrong rendering this view.'}
          description={error.message || String(error)}
        />
      );
    }
    return children;
  }
}
