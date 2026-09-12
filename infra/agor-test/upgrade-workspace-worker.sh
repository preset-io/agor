#!/bin/bash
# Run through SSM after build-workspace-runtime.sh. Keeps the previous container.
set -euo pipefail
release=$1
[[ "$release" =~ ^[a-f0-9]{16,64}$ ]]
python3 - <<'PY'
import json,os,sqlite3,subprocess,urllib.request,urllib.error
names=subprocess.check_output(['docker','ps','--format','{{.Names}}'],text=True).splitlines()
if any(n.startswith(('agor-sdk-','agor-tool-')) for n in names):raise RuntimeError('Active SDK/tool containers prevent upgrade')
p='/srv/agor/home/.agor/agor.db'
if os.path.exists(p):
 c=sqlite3.connect('file:'+p+'?mode=ro',uri=True)
 if c.execute("select count(*) from tasks where status in ('dispatching','running','stopping','awaiting_permission')").fetchone()[0]:raise RuntimeError('Active tasks prevent upgrade')
config=json.load(open('/opt/agor/workspace/config.json'))
request=urllib.request.Request('http://127.0.0.1:8787/drain',data=b'{}',headers={'Authorization':'Bearer '+config['controlToken'],'Content-Type':'application/json'})
try:
 with urllib.request.urlopen(request,timeout=120) as response:
  assert json.load(response)['drained']
except urllib.error.HTTPError as error:
 detail=json.loads(error.read())
 # The drain endpoint checks jobs.size before touching any branch. Completed
 # tool revisions already persist in RDS/S3; an expired idle placement cannot
 # write a new checkpoint and must not prevent replacing its old controller.
 if error.code != 409 or detail.get('error') != 'Error: Branch placement lease is no longer owned':raise
 print('Idle placement already expired; durable tool revisions retained')
PY
docker stop agor-workspace-worker
docker rename agor-workspace-worker "agor-workspace-worker-before-$release"
bash "/opt/agor/releases/$release/infra/agor-test/configure-workspace-worker.sh" "$release"
# A successful docker run means started, not yet ready for dependent operations.
curl --fail --silent --show-error --retry 30 --retry-connrefused --retry-delay 1 http://127.0.0.1:8787/health
