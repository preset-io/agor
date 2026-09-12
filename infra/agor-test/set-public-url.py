#!/usr/bin/env python3
"""Update this test deployment's URL without replacing EC2 or its data disk."""
import json
import os
import subprocess
import sys
import time
import urllib.request
from urllib.parse import urlparse

url = sys.argv[1].rstrip('/')
parsed = urlparse(url)
if parsed.scheme != 'https' or not parsed.hostname or parsed.path or parsed.query or parsed.fragment or parsed.username:
    raise SystemExit('An HTTPS origin is required')

def docker(*args):
    return subprocess.check_output(['docker', *args], text=True).strip()

info = json.loads(docker('inspect', 'agor'))[0]
assert info['HostConfig']['NetworkMode'] == 'default'
assert info['HostConfig']['PortBindings'] == {'3030/tcp': [{'HostIp': '', 'HostPort': '3030'}]}
assert info['HostConfig']['Binds'] == ['/srv/agor/home:/home/agor']
assert info['HostConfig']['RestartPolicy']['Name'] == 'unless-stopped'
backup = 'agor-url-backup'
if backup in docker('ps', '-a', '--format', '{{.Names}}').splitlines():
    raise SystemExit('Existing backup container needs operator review')
values = [v for v in info['Config']['Env'] if not v.startswith(('AGOR_BASE_URL=', 'CORS_ORIGIN='))]
values += ['AGOR_BASE_URL=' + url, 'CORS_ORIGIN=' + url]
assert all('\n' not in v for v in values)
env_file = '/opt/agor/runtime-url.env'
fd = os.open(env_file, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
with os.fdopen(fd, 'w') as f:
    f.write('\n'.join(values) + '\n')
try:
    docker('stop', 'agor')
    docker('rename', 'agor', backup)
    try:
        docker('run', '-d', '--name', 'agor', '--restart', 'unless-stopped',
               '-p', '3030:3030', '--env-file', env_file,
               '-v', '/srv/agor/home:/home/agor', info['Image'])
        for attempt in range(30):
            try:
                with urllib.request.urlopen('http://127.0.0.1:3030/health', timeout=2) as response:
                    assert json.load(response)['status'] == 'ok'
                break
            except Exception:
                if attempt == 29:
                    raise
                time.sleep(1)
    except Exception:
        subprocess.run(['docker', 'rm', '-f', 'agor'], check=False, stdout=subprocess.DEVNULL)
        docker('rename', backup, 'agor')
        docker('start', 'agor')
        raise
    print(json.dumps({'healthy': True, 'public_url': url, 'rollback_container': backup}))
finally:
    os.unlink(env_file)
