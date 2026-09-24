import { execFile } from 'node:child_process';

/** Open a URL without a shell. Resolves false when no browser could be launched. */
export function openInBrowser(url: string): Promise<boolean> {
  const [command, args] =
    process.platform === 'darwin'
      ? ['open', [url]]
      : process.platform === 'win32'
        ? ['rundll32', ['url.dll,FileProtocolHandler', url]]
        : ['xdg-open', [url]];
  return new Promise((resolve) => {
    try {
      const child = execFile(command, args, { timeout: 10_000 }, (error) => resolve(!error));
      child.on('error', () => resolve(false));
    } catch {
      resolve(false);
    }
  });
}
