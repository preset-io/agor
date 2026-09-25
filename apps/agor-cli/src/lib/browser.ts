import { spawn } from 'node:child_process';

/**
 * Open a URL without a shell. Resolves as soon as the opener process starts
 * (true) or fails to start (false); it never waits for the opener to exit, so a
 * blocking `xdg-open` cannot hold up the caller.
 */
export function openInBrowser(url: string): Promise<boolean> {
  const [command, args] =
    process.platform === 'darwin'
      ? ['open', [url]]
      : process.platform === 'win32'
        ? ['rundll32', ['url.dll,FileProtocolHandler', url]]
        : ['xdg-open', [url]];
  return new Promise((resolve) => {
    try {
      const child = spawn(command, args, { detached: true, stdio: 'ignore' });
      child.once('spawn', () => {
        child.unref();
        resolve(true);
      });
      child.once('error', () => resolve(false));
    } catch {
      resolve(false);
    }
  });
}
