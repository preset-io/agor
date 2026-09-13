#!/usr/bin/env python3
"""Single-tenant Agor comparison deployment. JuiceFS authority stays on the host."""
import argparse
import json
import os
from pathlib import Path
import re
import subprocess
from urllib.parse import urlparse

BINARY = '/usr/local/bin/juicefs'
MARKER = '.agor-juicefs-volume.json'


def config(filename):
    c = json.loads(Path(filename).read_text())
    for key in ('name', 'tenant'):
        if not re.fullmatch(r'[a-z][a-z0-9-]{0,40}', c[key]):
            raise ValueError('Unsafe deployment identity')
    # This deployment profile deliberately targets standard static-tenant Agor.
    # Multi-tenant hosting needs the corresponding tenant-aware mounts/config.
    if c['tenant'] != 'default':
        raise ValueError('This standalone profile requires the default static tenant')
    meta = urlparse(c['metadata_url'])
    if meta.scheme != 'postgres' or not meta.hostname or meta.password:
        raise ValueError('Use a PostgreSQL URL without an embedded password')
    if urlparse(c['bucket']).scheme != 'https':
        raise ValueError('An HTTPS S3 endpoint is required')
    for key in ('mount', 'cache', 'home', 'password_file'):
        p = Path(c[key])
        if not p.is_absolute() or '..' in p.parts or ',' in str(p) or str(p) == '/':
            raise ValueError('Paths must be absolute, non-root and contain no traversal or commas')
        c[key] = str(p)
    paths = [Path(c[k]).resolve() for k in ('mount', 'home', 'cache')]
    if any(a == b or a in b.parents or b in a.parents for i, a in enumerate(paths) for b in paths[i+1:]):
        raise ValueError('Mount, application home and cache must be separate directories')
    if not 1024 <= int(c.get('port', 3031)) <= 65535:
        raise ValueError('Invalid port')
    return c


def environment(c):
    secret = Path(c['password_file'])
    if secret.is_symlink() or secret.stat().st_mode & 0o077:
        raise ValueError('Metadata password file must be private and not a symlink')
    return {**os.environ, 'META_PASSWORD_FILE': str(secret)}


def identity(c):
    return {'schema': 1, 'name': c['name'], 'tenant': c['tenant']}


def mounted(c):
    result = subprocess.run(['findmnt', '-J', '-M', c['mount'], '-o', 'TARGET,FSTYPE'],
                            check=True, capture_output=True, text=True)
    mounts = json.loads(result.stdout)['filesystems']
    if len(mounts) != 1 or mounts[0]['fstype'] != 'fuse.juicefs':
        raise ValueError('Expected a JuiceFS mount; refusing local filesystem fallback')


def verify(c):
    mounted(c)
    if json.loads((Path(c['mount']) / MARKER).read_text()) != identity(c):
        raise ValueError('JuiceFS volume belongs to a different deployment or tenant')
    for name in ('repos', 'worktrees'):
        p = Path(c['mount']) / name
        if not p.is_dir() or p.is_symlink():
            raise ValueError('Workspace directories must be real directories on JuiceFS')


def prepare(c):
    mounted(c)
    root = Path(c['mount'])
    marker = root / MARKER
    if marker.exists():
        verify(c)
        return
    # Never adopt an arbitrary pre-existing filesystem as this tenant's volume.
    visible = [p for p in root.iterdir() if p.name not in ('.config', '.jfsconfig', '.stats', '.accesslog', '.control', '.trash')]
    if visible:
        raise ValueError('Refusing to initialize a nonempty/unidentified JuiceFS volume')
    with marker.open('x') as f:
        json.dump(identity(c), f)
    marker.chmod(0o600)
    for name in ('repos', 'worktrees'):
        p = root / name
        p.mkdir(mode=0o700)
        os.chown(p, 1000, 1000)


def docker_command(c):
    root = Path(c['mount'])
    return ['docker', 'run', '-d', '--name', c['name'], '--restart', 'unless-stopped',
            '-p', f"127.0.0.1:{int(c.get('port', 3031))}:3030",
            '-e', 'NODE_ENV=production', '-e', 'DAEMON_HOST=0.0.0.0',
            '-e', 'DAEMON_PORT=3030', '-e', 'AGOR_AGENTIC_TOOLS=none',
            '--mount', f"type=bind,src={c['home']},dst=/home/agor",
            '--mount', f'type=bind,src={root}/repos,dst=/home/agor/.agor/repos',
            '--mount', f'type=bind,src={root}/worktrees,dst=/home/agor/.agor/worktrees',
            c['image']]


def start(c):
    verify(c)
    home = Path(c['home'])
    home.mkdir(mode=0o700, parents=True, exist_ok=True)
    binding = home / MARKER
    if binding.exists():
        if json.loads(binding.read_text()) != identity(c):
            raise ValueError('Application home belongs to another deployment')
    elif list(home.iterdir()):
        raise ValueError('Use a fresh application home; existing Agor state is not migrated')
    else:
        binding.write_text(json.dumps(identity(c)))
        binding.chmod(0o600)
    os.chown(home, 1000, 1000)
    for p in (home / '.agor', home / '.agor/repos', home / '.agor/worktrees'):
        p.mkdir(mode=0o700, exist_ok=True)
        os.chown(p, 1000, 1000)
    subprocess.run(docker_command(c), check=True)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('action', choices=['format', 'mount', 'prepare', 'verify', 'start'])
    parser.add_argument('config')
    args = parser.parse_args()
    c = config(args.config)
    if args.action == 'format':
        subprocess.run([BINARY, 'format', '--storage', 's3', '--bucket', c['bucket'],
                        c['metadata_url'], c['name']], env=environment(c), check=True)
    elif args.action == 'mount':
        Path(c['mount']).mkdir(parents=True, exist_ok=True)
        Path(c['cache']).mkdir(parents=True, mode=0o700, exist_ok=True)
        # Default close-to-open consistency, no writeback or relaxed open cache.
        os.execve(BINARY, [BINARY, 'mount', '-o', 'allow_other', '--cache-dir', c['cache'],
                          '--cache-size', '4096', '--verify-cache-checksum', 'full',
                          c['metadata_url'], c['mount']], environment(c))
    else:
        {'prepare': prepare, 'verify': verify, 'start': start}[args.action](c)


if __name__ == '__main__':
    main()
