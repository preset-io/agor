import { describe, expect, it } from 'vitest';
import {
  daemonUrlForRuntime,
  resolveUiRuntime,
  routerBasenameForRuntime,
  usesSameOriginDaemon,
} from './urlRuntime';

describe('UI URL runtime resolution', () => {
  it('models bundled daemon UI as /ui basename and same-origin API', () => {
    const runtime = resolveUiRuntime({ baseUrl: '/ui/', pathname: '/ui/kb/global/readme.md' });

    expect(runtime.mode).toBe('bundled-daemon-ui');
    expect(routerBasenameForRuntime(runtime)).toBe('/ui');
    expect(usesSameOriginDaemon(runtime)).toBe(true);
    expect(daemonUrlForRuntime(runtime, 'https://agor.example.com', '3030')).toBe(
      'https://agor.example.com'
    );
  });

  it('models root Vite dev as root basename and daemon-port API', () => {
    const runtime = resolveUiRuntime({ baseUrl: '/', pathname: '/kb/global/readme.md' });

    expect(runtime.mode).toBe('root-vite-dev');
    expect(routerBasenameForRuntime(runtime)).toBe('');
    expect(usesSameOriginDaemon(runtime)).toBe(false);
    expect(daemonUrlForRuntime(runtime, 'http://localhost:5173', '3030')).toBe(
      'http://localhost:3030'
    );
  });

  it('models canonical /ui deep links in Vite dev as /ui basename but daemon-port API', () => {
    const runtime = resolveUiRuntime({ baseUrl: '/', pathname: '/ui/kb/global/readme.md' });

    expect(runtime.mode).toBe('canonical-dev-deeplink');
    expect(routerBasenameForRuntime(runtime)).toBe('/ui');
    expect(usesSameOriginDaemon(runtime)).toBe(false);
    expect(daemonUrlForRuntime(runtime, 'http://10.33.92.175:14082', '12082')).toBe(
      'http://10.33.92.175:12082'
    );
  });
});
