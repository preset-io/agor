#!/usr/bin/env python3
"""Small operator-only control plane. No tenant API, shell endpoint or browser AWS credentials."""
import concurrent.futures, datetime, hashlib, hmac, http.cookies, json, os, pathlib, secrets, subprocess, threading, time, urllib.request, uuid
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

ROOT = pathlib.Path(__file__).parent
CONFIG = json.loads(pathlib.Path(os.environ.get('AGOR_OPS_CONFIG', '/etc/agor-ops.json')).read_text())
DATA = pathlib.Path(CONFIG.get('dataDir', '/var/lib/agor-ops')); DATA.mkdir(mode=0o700, parents=True, exist_ok=True)
RUNTIME = json.loads(pathlib.Path(CONFIG['workerConfig']).read_text())
TOKEN = RUNTIME['controlToken']
lock = threading.RLock(); operation_lock = threading.Lock(); sessions = {}; attempts = []
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
                    workers.append({'id':instance['InstanceId'],'origin':'http://'+instance['PrivateIpAddress']+':8787','name':'Elastic worker','type':instance['InstanceType'],'az':instance['Placement']['AvailabilityZone'],'elastic':True})
    return workers

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

def transfer(op, source, target, tenant, branch):
    payload={'operationId':op['id'],'tenantId':tenant,'branchId':branch}
    try:
        update(op,'Holding source worker; active work must finish first.','running')
        rpc(source['origin'],'/ops/hold',payload)
        update(op,'Holding destination worker.')
        rpc(target['origin'],'/ops/hold',payload)
        update(op,'Saving private workspace to S3. Source files remain in place.')
        exported=rpc(source['origin'],'/ops/export',payload,960)
        update(op,'Checkpoint acknowledged. Restoring onto destination.')
        restored=rpc(target['origin'],'/ops/import',{**payload,'recovery':exported['hash'],'repository':exported['repository']},960)
        update(op,'Destination verified. Releasing workers.')
        rpc(target['origin'],'/ops/release',payload); rpc(source['origin'],'/ops/release',payload)
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
        try:
            cookie=http.cookies.SimpleCookie(self.headers.get('Cookie','')); token=cookie['agor_ops'].value
            with lock: session=sessions.get(token)
            if session and session['expires']>time.time(): return session
        except (KeyError, http.cookies.CookieError): pass
        return None
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
            with lock: snapshot=json.loads(json.dumps({**state,'operations':operations[-50:][::-1],'csrf':session['csrf'],'region':CONFIG['region'],'bucket':RUNTIME['bucket'],'group':CONFIG['group'],'maxAdditionalWorkers':CONFIG.get('maxWorkers',4)}))
            return self.reply(200,snapshot)
        return self.reply(404,{'error':'Not found'})
    def do_POST(self):
        try:
            if self.headers.get('Origin') != CONFIG['publicOrigin']: return self.reply(403,{'error':'Origin rejected'})
            body=self.body()
            if self.path=='/ops/api/login':
                with lock:
                    attempts[:]=[t for t in attempts if time.time()-t<60]
                    if len(attempts)>=10: return self.reply(429,{'error':'Too many attempts. Try again in one minute.'})
                    attempts.append(time.time())
                candidate=hashlib.pbkdf2_hmac('sha256',str(body.get('password','')).encode(),bytes.fromhex(CONFIG['salt']),200000).hex()
                if body.get('username')!='matt' or not hmac.compare_digest(candidate,CONFIG['passwordHash']): return self.reply(401,{'error':'Incorrect username or password'})
                token=secrets.token_urlsafe(32)
                with lock: sessions[token]={'expires':time.time()+43200,'csrf':secrets.token_urlsafe(32)}
                return self.reply(200,{'ok':True},extra={'Set-Cookie':'agor_ops='+token+'; Path=/ops; HttpOnly; Secure; SameSite=Strict; Max-Age=43200'})
            session=self.session()
            if not session or not hmac.compare_digest(self.headers.get('X-Ops-CSRF',''),session['csrf']): return self.reply(403,{'error':'Session expired; sign in again'})
            if self.path=='/ops/api/logout':
                cookie=http.cookies.SimpleCookie(self.headers.get('Cookie',''))
                with lock: sessions.pop(cookie['agor_ops'].value,None)
                return self.reply(200,{'ok':True},extra={'Set-Cookie':'agor_ops=; Path=/ops; HttpOnly; Secure; SameSite=Strict; Max-Age=0'})
            with lock: workers={w['id']:dict(w) for w in state['workers']}
            if self.path=='/ops/api/release':
                worker=workers.get(body.get('worker'))
                if not worker or not worker.get('hold') or worker.get('operationRunning'): raise ValueError('No releasable hold on this worker')
                rpc(worker['origin'],'/ops/release',{'operationId':worker['hold']})
                with lock:
                    operations.append({'id':str(uuid.uuid4()),'kind':'release','status':'complete','detail':'Operator released '+worker['id'],'createdAt':now(),'steps':[]});save()
                return self.reply(200,{'ok':True})
            if self.path not in ('/ops/api/transfer','/ops/api/provision'): return self.reply(404,{'error':'Not found'})
            args=[]
            if self.path.endswith('/transfer'):
                source=workers.get(body.get('source')); target=workers.get(body.get('target'))
                if not source or not target or source['id']==target['id']: raise ValueError('Choose distinct registered workers')
                tenant=body.get('tenant'); branch=body.get('branch')
                if not any(r['tenantId']==tenant and r['branchId']==branch and r['resident'] for r in source.get('residents',[])): raise ValueError('Source workspace not found')
                if not source.get('reachable') or not target.get('reachable'): raise ValueError('Both workers must be reachable')
                args=[source,target,tenant,branch]
            if not operation_lock.acquire(blocking=False): raise ValueError('Another fleet operation is running')
            op={'id':str(uuid.uuid4()),'kind':'transfer' if args else 'provision','status':'queued','detail':'Queued by matt','createdAt':now(),'steps':[]}
            if args: op.update(source=source['id'],target=target['id'],tenant=tenant,branch=branch)
            with lock: operations.append(op); save()
            threading.Thread(target=transfer if args else provision,args=(op,*args),daemon=True).start()
            return self.reply(202,op)
        except (ValueError,RuntimeError) as e: self.reply(409,{'error':str(e)})
        except Exception: self.reply(500,{'error':'Operation failed; inspect the ops service journal'})

if __name__=='__main__':
    save(); threading.Thread(target=collector,daemon=True).start()
    ThreadingHTTPServer(('0.0.0.0',CONFIG.get('port',8790)),Handler).serve_forever()
