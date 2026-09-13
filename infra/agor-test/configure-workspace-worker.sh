#!/bin/bash
# Run with the deployed immutable image tag. Secrets are read by the host only.
set -euo pipefail
release=$1
[[ "$release" =~ ^[a-f0-9]{16,64}$ ]]
umask 077
mkdir -p /opt/agor/workspace /opt/agor/agentic-tools /var/lib/agor
curl -fsSL https://truststore.pki.rds.amazonaws.com/global/global-bundle.pem -o /opt/agor/workspace/rds-ca.pem
aws secretsmanager get-secret-value --secret-id agor-workspace-runtime --query SecretString --output text --region ap-southeast-2 > /opt/agor/workspace/runtime-secret.json
python3 - "$release" <<'PY'
import json,sys,subprocess,os
release=sys.argv[1]
secret=json.load(open('/opt/agor/workspace/runtime-secret.json'))
ip=subprocess.check_output(['hostname','-I'],text=True).split()[0]
entry='/opt/agor-runtime/lib/node_modules/agor-live/dist/executor/cli.js'
config={**secret,'databaseIamAuth':True,'sslCaPath':'/run/agor-worker/rds-ca.pem','bucket':'agor-workspace-blobs-148253003792','root':'/var/lib/agor','origin':'http://'+ip+':8787','image':'agor-workspace:'+release,'port':8787,'daemonUrl':'https://agor.skellige.com.au','managedToolsRoot':'/opt/agor/agentic-tools','sourceHome':'/home/agor','executorEntry':entry,'clone':'reflink'}
# An explicit policy file survives immutable worker upgrades; omission retains legacy placement.
policy_path='/opt/agor/workspace/cache-policy.json'
policy=json.load(open(policy_path)) if os.path.exists(policy_path) else None
if policy is not None: config['cachePolicy']=policy
json.dump(config,open('/opt/agor/workspace/config.json','w'))
if ip=='10.87.2.164':
 json.dump({'workers':['http://10.87.2.164:8787','http://10.87.1.107:8787'],'controlToken':secret['controlToken'],'executorEntry':entry,'branchReflinkRoot':'/home/agor/.agor/branch-bases',**({'cachePolicy':policy} if policy is not None else {})},open('/srv/agor/dispatcher.json','w'))
 os.chown('/srv/agor/dispatcher.json',1000,1000)
os.unlink('/opt/agor/workspace/runtime-secret.json')
PY
# Install managed Claude through Agor's normal package manager in an ephemeral
# setup home. Only the versioned runtime directory is retained.
chown 1000:1000 /opt/agor/agentic-tools
docker run --rm --entrypoint agor -e AGOR_AGENTIC_TOOLS_DIR=/opt/agentic-tools \
  -v /opt/agor/agentic-tools:/opt/agentic-tools "agor-workspace:$release" \
  init --non-interactive --agentic-tools claude-code
# This trusted process alone receives SQL/IAM authority and the Docker socket.
# SDK/tool containers created by it receive neither mount.
docker run -d --name agor-workspace-worker --restart unless-stopped --network host --user 0 \
  -e AWS_REGION=ap-southeast-2 \
  -v /var/run/docker.sock:/var/run/docker.sock \
  -v /usr/bin/docker:/usr/local/bin/docker:ro \
  -v /var/lib/agor:/var/lib/agor \
  -v /opt/agor/workspace:/run/agor-worker:ro \
  -v /srv/agor/home:/home/agor:ro \
  --entrypoint node "agor-workspace:$release" \
  /opt/agor-runtime/lib/node_modules/agor-live/dist/executor/workspaces/worker-cli.js /run/agor-worker/config.json
