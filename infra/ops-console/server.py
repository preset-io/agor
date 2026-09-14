#!/usr/bin/env python3
"""Small operator-only control plane. No tenant API, shell endpoint or browser AWS credentials."""
import base64, concurrent.futures, datetime, hmac, json, os, pathlib, subprocess, threading, time, urllib.request, uuid
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

ROOT = pathlib.Path(__file__).parent
CONFIG = json.loads(pathlib.Path(os.environ.get('AGOR_OPS_CONFIG', '/etc/agor-ops.json')).read_text())
DATA = pathlib.Path(CONFIG.get('dataDir', '/var/lib/agor-ops')); DATA.mkdir(mode=0o700, parents=True, exist_ok=True)
RUNTIME = json.loads(pathlib.Path(CONFIG['workerConfig']).read_text())
TOKEN = RUNTIME['controlToken']
lock = threading.RLock(); operation_lock = threading.Lock()
state = {'workers': [], 'cloud': None, 'sampledAt': None, 'collectionError': None}
journal = DATA / 'operations.json'
operations = json.loads(journal.read_text()) if journal.exists() else []
for op in operations:
    if op['status'] in ('running', 'queued'): op.update(status='interrupted', detail='Ops service restarted. Check worker holds before releasing them.')

def now(): return datetime.datetime.now(datetime.timezone.utc).isoformat()
def save():
    temp = journal.with_suffix('.tmp'); temp.write_text(json.dumps(operations)); temp.chmod(0o600); os.replace(temp, journal)
def aws(*args):
    result = subprocess.run(['aws', *args, '--region', CONFIG['region'], '--output', 'json'], capture_output=True, text=True, timeout=45)
    if result.returncode: raise RuntimeError('AWS request failed: '+ result.stderr[-600:])
    return json.loads(result.stdout or '{}')
def rpc(origin, route, payload=None, timeout=12):
    req = urllib.request.Request(origin+route, data=json.dumps(payload).encode() if payload is not None else None,
        headers={'Authorization':'Bearer '+TOKEN,'Content-Type':'application/json'})
    try:
        with urllib.request.urlopen(req, timeout=timeout) as response: return json.load(response)
    except urllib.error.HTTPError as e:
        try: detail = json.loads(e.read()).get('error', 'Worker request rejected')
        except Exception: detail = 'Worker request rejected'
        raise RuntimeError(str(detail)) from None

def discover():
    workers = list(CONFIG['workers'])
    group = aws('autoscaling','describe-auto-scaling-groups','--auto-scaling-group-names',CONFIG['group'])
    ids = [i['InstanceId'] for g in group.get('AutoScalingGroups',[]) for i in g['Instances'] if i['LifecycleState'] not in ('Terminating','Terminated')]
    if ids:
        result = aws('ec2','describe-instances','--instance-ids',*ids)
        for reservation in result['Reservations']:
            for instance in reservation['Instances']:
                if instance.get('PrivateIpAddress'):
                    workers.append({'id':instance['InstanceId'],'origin':'http://'+instance['PrivateIpAddress']+':8787','name':'Elastic worker','type':instance['InstanceType'],'az':instance['Placement']['AvailabilityZone'],'bornAt':instance['LaunchTime'],'elastic':True})
    return workers

def branch_labels(collected):
    import sqlite3
    try:
        with sqlite3.connect('file:/srv/agor/home/.agor/agor.db?mode=ro', uri=True, timeout=1) as db:
            names=dict(db.execute('select branch_id, name from branches'))
        for worker in collected:
            for resident in worker.get('residents',[]):
                if resident['tenantId']=='default': resident['label']=names.get(resident['branchId'])
    except (sqlite3.Error, OSError): pass

def collect_worker(worker):
    try: return {**worker, **rpc(worker['origin'], '/ops/status'), 'reachable':True, 'observedAt':now()}
    except Exception as e: return {**worker,'reachable':False,'error':str(e),'observedAt':now()}

def cloud_metrics():
    end = datetime.datetime.now(datetime.timezone.utc); start = end-datetime.timedelta(hours=1)
    queries=[]
    for name in ['GetRequests','PutRequests','4xxErrors','5xxErrors','BytesDownloaded','BytesUploaded','FirstByteLatency']:
        queries.append({'Id':'m'+str(len(queries)), 'MetricStat':{'Metric':{'Namespace':'AWS/S3','MetricName':name,'Dimensions':[{'Name':'BucketName','Value':RUNTIME['bucket']},{'Name':'FilterId','Value':'agor-ops'}]},'Period':300,'Stat':'Average' if name=='FirstByteLatency' else 'Sum'},'ReturnData':True})
    raw = aws('cloudwatch','get-metric-data','--metric-data-queries',json.dumps(queries),'--start-time',start.isoformat(),'--end-time',end.isoformat())
    metrics=[]
    by_id={r['Id']:r for r in raw.get('MetricDataResults',[])}
    for query in queries:
        result=by_id.get(query['Id'],{})
        values=result.get('Values',[]); points=sorted(zip(result.get('Timestamps',[]), values))
        metrics.append({'name':query['MetricStat']['Metric']['MetricName'],'value':(sum(values)/len(values) if query['MetricStat']['Stat']=='Average' else sum(values)) if values else None,'points':points,'status':result.get('StatusCode')})
    return {'bucket':RUNTIME['bucket'],'region':CONFIG['region'],'sampledAt':now(),'window':'Last hour · 5-minute periods','metrics':metrics}

def collector():
    tick=0
    while True:
        try:
            workers=discover()
            with concurrent.futures.ThreadPoolExecutor(max_workers=8) as pool: collected=list(pool.map(collect_worker,workers))
            branch_labels(collected)
            with lock: state.update(workers=collected,sampledAt=now(),collectionError=None)
        except Exception as e:
            with lock: state['collectionError']=str(e)
        if tick % 4 == 0:
            try:
                cloud=cloud_metrics()
                with lock: state['cloud']=cloud
            except Exception as e:
                with lock: state['cloud']={'bucket':RUNTIME['bucket'],'error':str(e),'sampledAt':now()}
        tick+=1; time.sleep(15)

def update(op, detail, status=None):
    with lock:
        op['detail']=detail; op['updatedAt']=now(); op['steps'].append({'at':now(),'detail':detail})
        if status: op['status']=status
        save()

def transfer(op, source, target, tenant, branch, fleet=None):
    payload={'operationId':op['id'],'tenantId':tenant,'branchId':branch}
    fleet=fleet or [source,target]
    try:
        update(op,'Holding registered workers; all must be idle for this first operator workflow.','running')
        for worker in sorted(fleet,key=lambda w:w['origin']): rpc(worker['origin'],'/ops/hold',payload)
        # Retained source replicas must not supersede a more recently used private copy.
        candidates=[]
        for worker in fleet:
            status=rpc(worker['origin'],'/ops/status')
            for resident in status.get('residents',[]):
                if resident['tenantId']==tenant and resident['branchId']==branch and resident['resident']:
                    candidates.append((resident.get('epoch') or 0,resident.get('lastUsed') or 0,worker['origin']))
        if not candidates or max(candidates)[2]!=source['origin']:
            raise RuntimeError('Choose the most recently used resident copy as the transfer source')
        update(op,'Saving private workspace to S3. Source files remain in place.')
        exported=rpc(source['origin'],'/ops/export',payload,960)
        update(op,'Checkpoint acknowledged. Restoring onto destination.')
        restored=rpc(target['origin'],'/ops/import',{**payload,'recovery':exported['hash'],'epoch':exported['epoch'],'repository':exported['repository']},960)
        update(op,'Destination verified. Releasing workers.')
        for worker in [target]+[w for w in fleet if w['origin']!=target['origin']]: rpc(worker['origin'],'/ops/release',payload)
        update(op,'Transfer complete. '+str(restored['sessions'])+' sessions restored; source copy retained.','complete')
    except Exception as e: update(op,str(e)+'. Any acquired holds remain; inspect and release them explicitly.','failed')
    finally: operation_lock.release()

def provision(op):
    try:
        update(op,'Requesting one worker from the Terraform-managed Auto Scaling group.','running')
        group=aws('autoscaling','describe-auto-scaling-groups','--auto-scaling-group-names',CONFIG['group'])['AutoScalingGroups'][0]
        desired=group['DesiredCapacity']+1
        if desired > group['MaxSize']: raise RuntimeError('Fleet limit reached')
        old={i['InstanceId'] for i in group['Instances']}
        aws('autoscaling','set-desired-capacity','--auto-scaling-group-name',CONFIG['group'],'--desired-capacity',str(desired),'--honor-cooldown')
        update(op,'Capacity requested. Waiting for EC2, image loading and worker health.')
        for _ in range(120):
            time.sleep(10)
            workers=discover()
            new=[w for w in workers if w.get('elastic') and w['id'] not in old]
            for worker in new:
                try:
                    status=rpc(worker['origin'],'/ops/status',timeout=3)
                    if status.get('accepting') and status.get('freeSlots',0)>0:
                        update(op,'Worker '+worker['id']+' is healthy and discoverable by the dispatcher.','complete'); return
                except Exception: pass
        raise RuntimeError('Worker not ready after 20 minutes. Capacity remains requested; inspect EC2 bootstrap.')
    except Exception as e: update(op,str(e),'failed')
    finally: operation_lock.release()

class Handler(BaseHTTPRequestHandler):
    def setup(self): super().setup(); self.connection.settimeout(15)
    def log_message(self, fmt, *args): pass
    def reply(self, code, value, content='application/json', extra=None):
        data=json.dumps(value).encode() if content=='application/json' else value
        self.send_response(code)
        for k,v in {'Content-Type':content,'Content-Length':str(len(data)),'Cache-Control':'no-store','X-Content-Type-Options':'nosniff','Referrer-Policy':'no-referrer','Content-Security-Policy':"default-src 'self'; style-src 'self'; script-src 'self'; img-src 'self' data:; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",**(extra or {})}.items(): self.send_header(k,v)
        self.end_headers(); self.wfile.write(data)
    def session(self):
        bearer=self.headers.get('Authorization','')
        if not bearer.startswith('Bearer ') or len(bearer)>16384: return None
        try:
            # Decode only to select the subject and reject non-browser credential
            # families. Agor verifies this exact token before any authority is used.
            encoded=bearer[7:].split('.')[1]
            claims=json.loads(base64.urlsafe_b64decode(encoded+'='*(-len(encoded)%4)))
            subject=str(uuid.UUID(claims['sub']))
            if claims.get('type')!='access': return None
            if claims.get('tenant_id')!=CONFIG['operatorTenant']: return None
            request=urllib.request.Request(CONFIG['agorOrigin']+'/users/'+subject,
                headers={'Authorization':bearer})
            with urllib.request.urlopen(request,timeout=5) as response: user=json.load(response)
            if user.get('user_id')!=subject or user.get('role')!='superadmin': return None
            return {'user':{'id':subject,'name':user.get('name') or user.get('email') or subject},'csrf':'agor-session'}
        except (ValueError,KeyError,IndexError,urllib.error.URLError,TimeoutError): return None
    def body(self):
        size=int(self.headers.get('Content-Length','0'))
        if size<1 or size>16384: raise ValueError('Invalid request size')
        return json.loads(self.rfile.read(size))
    def do_GET(self):
        if self.path=='/ops/health': return self.reply(200,{'status':'ok'})
        if self.path=='/internal/workers':
            if not hmac.compare_digest(self.headers.get('Authorization',''),'Bearer '+TOKEN): return self.reply(403,{'error':'Forbidden'})
            with lock: workers=[w['origin'] for w in state['workers'] if w.get('reachable')]
            return self.reply(200,{'workers':workers})
        if self.path in ('/ops','/ops/','/ops/app.js','/ops/style.css'):
            file,mime={'/ops':('index.html','text/html'),'/ops/':('index.html','text/html'),'/ops/app.js':('app.js','text/javascript'),'/ops/style.css':('style.css','text/css')}[self.path]
            return self.reply(200,(ROOT/file).read_bytes(),mime)
        session=self.session()
        if not session: return self.reply(401,{'error':'Sign in to view fleet status'})
        if self.path=='/ops/api/state':
            with lock: snapshot=json.loads(json.dumps({**state,'operations':operations[-50:][::-1],'csrf':session['csrf'],'operator':session['user'],'region':CONFIG['region'],'bucket':RUNTIME['bucket'],'group':CONFIG['group'],'maxAdditionalWorkers':CONFIG.get('maxWorkers',4)}))
            return self.reply(200,snapshot)
        return self.reply(404,{'error':'Not found'})
    def do_POST(self):
        try:
            if self.headers.get('Origin') != CONFIG['publicOrigin']: return self.reply(403,{'error':'Origin rejected'})
            body=self.body()
            session=self.session()
            if not session or not hmac.compare_digest(self.headers.get('X-Ops-CSRF',''),session['csrf']): return self.reply(403,{'error':'Session expired; sign in again'})
            with lock: workers={w['id']:dict(w) for w in state['workers']}
            if self.path=='/ops/api/release':
                worker=workers.get(body.get('worker'))
                if not worker or not worker.get('hold') or worker.get('operationRunning'): raise ValueError('No releasable hold on this worker')
                rpc(worker['origin'],'/ops/release',{'operationId':worker['hold']})
                with lock:
                    operations.append({'id':str(uuid.uuid4()),'kind':'release','status':'complete','operator':session['user'],'detail':'Operator released '+worker['id'],'createdAt':now(),'steps':[]});save()
                return self.reply(200,{'ok':True})
            if self.path not in ('/ops/api/transfer','/ops/api/provision'): return self.reply(404,{'error':'Not found'})
            args=[]
            if self.path.endswith('/transfer'):
                source=workers.get(body.get('source')); target=workers.get(body.get('target'))
                if not source or not target or source['id']==target['id']: raise ValueError('Choose distinct registered workers')
                tenant=body.get('tenant'); branch=body.get('branch')
                if not any(r['tenantId']==tenant and r['branchId']==branch and r['resident'] for r in source.get('residents',[])): raise ValueError('Source workspace not found')
                if not source.get('reachable') or not target.get('reachable'): raise ValueError('Both workers must be reachable')
                args=[source,target,tenant,branch,list(workers.values())]
            if not operation_lock.acquire(blocking=False): raise ValueError('Another fleet operation is running')
            op={'id':str(uuid.uuid4()),'kind':'transfer' if args else 'provision','status':'queued','detail':'Queued by '+session['user']['name'],'operator':session['user'],'createdAt':now(),'steps':[]}
            if args: op.update(source=source['id'],target=target['id'],tenant=tenant,branch=branch)
            with lock: operations.append(op); save()
            threading.Thread(target=transfer if args else provision,args=(op,*args),daemon=True).start()
            return self.reply(202,op)
        except (ValueError,RuntimeError) as e: self.reply(409,{'error':str(e)})
        except Exception: self.reply(500,{'error':'Operation failed; inspect the ops service journal'})

if __name__=='__main__':
    save(); threading.Thread(target=collector,daemon=True).start()
    ThreadingHTTPServer(('0.0.0.0',CONFIG.get('port',8790)),Handler).serve_forever()
