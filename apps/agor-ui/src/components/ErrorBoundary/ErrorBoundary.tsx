import { Alert } from 'antd';
import { Component, type ErrorInfo, type ReactNode } from 'react';
import { GlobalCrashScreen } from './GlobalCrashScreen';

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
}

export class ErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  state: ErrorBoundaryState = {
    error: null,
    errorInfo: null,
    resetKey: this.props.resetKey,
  };

  static getDerivedStateFromError(error: Error): Partial<ErrorBoundaryState> {
    return { error };
  }

  static getDerivedStateFromProps(
    props: ErrorBoundaryProps,
    state: ErrorBoundaryState
  ): Partial<ErrorBoundaryState> | null {
    if (props.resetKey !== state.resetKey) {
      return { error: null, errorInfo: null, resetKey: props.resetKey };
    }
    return null;
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error('ErrorBoundary caught render error:', error, info.componentStack);
    this.setState({ errorInfo: info });
  }

  render() {
    const { error, errorInfo } = this.state;
    const { variant = 'scoped', fallbackTitle, children } = this.props;

    if (error) {
      if (variant === 'global') {
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
