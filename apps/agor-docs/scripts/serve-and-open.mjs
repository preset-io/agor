#!/usr/bin/env node
// `pnpm serve`: serve the static export and open it in the default browser once
// it's listening. serve has no --open flag, so watch its output for the URL it
// actually bound (it moves to another port when 3000 is taken).
import { spawn } from 'node:child_process';

const server = spawn('serve', ['out', '--listen', '3000', '--no-clipboard'], {
  stdio: ['inherit', 'pipe', 'pipe'],
  shell: process.platform === 'win32',
});

let opened = false;
function watch(chunk, sink) {
  sink.write(chunk);
  if (opened) return;
  const url = chunk.toString().match(/https?:\/\/(?:localhost|127\.0\.0\.1):\d+/)?.[0];
  if (!url) return;
  opened = true;
  const [cmd, args] =
    process.platform === 'darwin'
      ? ['open', [url]]
      : process.platform === 'win32'
        ? ['cmd', ['/c', 'start', '', url]]
        : ['xdg-open', [url]];
  spawn(cmd, args, { stdio: 'ignore', detached: true })
    .on('error', () => console.log(`Open ${url} in your browser.`))
    .unref();
}

server.stdout.on('data', (chunk) => watch(chunk, process.stdout));
server.stderr.on('data', (chunk) => watch(chunk, process.stderr));
server.on('exit', (code) => process.exit(code ?? 0));
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => server.kill(signal));
}
