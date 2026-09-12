#!/usr/bin/env python3
"""Switch the existing test app to a built worker release, preserving user data."""
import json, os, re, shutil, sqlite3, subprocess, sys, time, urllib.request
release=sys.argv[1]
assert re.fullmatch(r'[a-f0-9]{16,64}',release)
def docker(*args):
 return subprocess.check_output(['docker',*args],text=True).strip()
backup='agor-before-'+release
if backup in docker('ps','-a','--format','{{.Names}}').splitlines():
 raise SystemExit('A prior workspace rollback container exists; inspect it before another rollout')
c=sqlite3.connect('file:/srv/agor/home/.agor/agor.db?mode=ro',uri=True)
assert c.execute("select count(*) from tasks where status in ('running','dispatching','stopping','awaiting_permission')").fetchone()[0]==0, 'Active tasks must finish before rollout'
c.close()
info=json.loads(docker('inspect','agor'))[0]
config='/srv/agor/home/.agor/config.yaml'
config_backup='/opt/agor/workspace/config-before-'+release+'.yaml'
assert not os.path.exists(config_backup)
shutil.copyfile(config,config_backup);os.chmod(config_backup,0o600)
values=[v for v in info['Config']['Env'] if not v.startswith(('AGOR_AGENTIC_TOOLS=','AGOR_AGENTIC_TOOLS_DIR=','AGOR_MANAGED_AGENTIC_TOOLS='))]
values+=['AGOR_AGENTIC_TOOLS=claude-code','AGOR_MANAGED_AGENTIC_TOOLS=1','AGOR_AGENTIC_TOOLS_DIR=/opt/agentic-tools']
env_file='/opt/agor/workspace/app.env'
with open(env_file,'w') as f:f.write('\n'.join(values)+'\n')
os.chmod(env_file,0o600)
image='agor-workspace:'+release
os.chmod('/opt/agor/workspace/enable.mjs',0o644)
try:
 docker('stop','agor');docker('rename','agor',backup)
 try:
  docker('run','--rm','--entrypoint','node','-v','/srv/agor/home:/home/agor','-v','/opt/agor/workspace/enable.mjs:/run/enable.mjs:ro',image,'/run/enable.mjs')
  docker('run','-d','--name','agor','--restart','unless-stopped','-p','3030:3030','--env-file',env_file,'-v','/srv/agor/home:/home/agor','-v','/srv/agor/dispatcher.json:/run/agor/dispatcher.json:ro','-v','/opt/agor/agentic-tools:/opt/agentic-tools:ro',image)
  for attempt in range(90):
   try:
    with urllib.request.urlopen('http://127.0.0.1:3030/health',timeout=2) as response:assert json.load(response)['status']=='ok'
    break
   except Exception:
    if attempt==89:raise
    time.sleep(1)
 except Exception:
  subprocess.run(['docker','rm','-f','agor'],stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)
  shutil.copyfile(config_backup,config);os.chown(config,1000,1000)
  docker('rename',backup,'agor');docker('start','agor')
  raise
 print(json.dumps({'healthy':True,'image':image,'url':'https://agor.skellige.com.au/ui/','workspace_backend':'local_replicated','adapter':'claude_workspace','rollback_container':backup}))
finally:
 os.unlink(env_file)
