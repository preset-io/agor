import hashlib, importlib.util, json, os, pathlib, tempfile, threading, unittest, urllib.error, urllib.request
from unittest.mock import patch
from http.server import ThreadingHTTPServer

class OpsTest(unittest.TestCase):
 @classmethod
 def setUpClass(cls):
  cls.tmp=tempfile.TemporaryDirectory();root=pathlib.Path(cls.tmp.name)
  (root/'worker.json').write_text(json.dumps({'controlToken':'x'*40,'bucket':'test-bucket'}))
  salt='aa'*16
  (root/'config.json').write_text(json.dumps({'workerConfig':str(root/'worker.json'),'dataDir':str(root/'data'),'region':'ap-southeast-2','workers':[],'group':'test','publicOrigin':'https://ops.test','salt':salt,'passwordHash':hashlib.pbkdf2_hmac('sha256',b'test-password',bytes.fromhex(salt),200000).hex()}))
  os.environ['AGOR_OPS_CONFIG']=str(root/'config.json')
  spec=importlib.util.spec_from_file_location('ops',pathlib.Path(__file__).with_name('server.py'));cls.module=importlib.util.module_from_spec(spec);spec.loader.exec_module(cls.module)
  cls.http=ThreadingHTTPServer(('127.0.0.1',0),cls.module.Handler);cls.thread=threading.Thread(target=cls.http.serve_forever,daemon=True);cls.thread.start();cls.url='http://127.0.0.1:'+str(cls.http.server_port)
 @classmethod
 def tearDownClass(cls):cls.http.shutdown();cls.http.server_close();cls.tmp.cleanup()
 def request(self,path,body=None,headers=None):
  r=urllib.request.Request(self.url+path,data=json.dumps(body).encode() if body is not None else None,headers=headers or {})
  try:return urllib.request.urlopen(r)
  except urllib.error.HTTPError as e:return e
 def test_auth_and_csrf(self):
  self.assertEqual(self.request('/ops/api/state').status,401)
  self.assertEqual(self.request('/internal/workers').status,403)
  self.assertEqual(self.request('/ops/api/state',headers={'Cookie':'agor_ops=old-password-session'}).status,401)
  identity={'user':{'id':'operator','name':'Max'},'csrf':'agor-session'}
  with patch.object(self.module.Handler,'session',return_value=identity):
   self.assertEqual(self.request('/ops/api/provision',{},{}).status,403)
   headers={'Origin':'https://ops.test','X-Ops-CSRF':'wrong'}
   self.assertEqual(self.request('/ops/api/provision',{},headers).status,403)
   headers['X-Ops-CSRF']='agor-session'
   self.assertEqual(self.request('/ops/api/transfer',{'source':'injected-host','target':'other','tenant':'other-tenant','branch':'x'},headers).status,409)
 def test_live_agor_authority(self):
  import base64,io
  m=self.module;m.CONFIG.update(operatorTenant='default',agorOrigin='http://127.0.0.1:3030')
  uid='57a26c48-a521-4ba4-b248-dfd5f104fe17'
  def token(**changes):
   claims={'sub':uid,'type':'access','tenant_id':'default',**changes}
   return 'Bearer header.'+base64.urlsafe_b64encode(json.dumps(claims).encode()).decode().rstrip('=')+'.signature'
  handler=object.__new__(m.Handler)
  for role in ['superadmin','admin','member']:
   handler.headers={'Authorization':token()}
   with patch.object(m.urllib.request,'urlopen',return_value=io.BytesIO(json.dumps({'user_id':uid,'role':role,'name':'Max'}).encode())) as call:
    self.assertEqual(bool(handler.session()),role=='superadmin')
    self.assertEqual(call.call_args.args[0].headers['Authorization'],token())
  for claims in [{'type':'refresh'},{'type':'service'},{'tenant_id':'other'},{'tenant_id':None}]:
   handler.headers={'Authorization':token(**claims)}
   with patch.object(m.urllib.request,'urlopen') as call:
    self.assertIsNone(handler.session());call.assert_not_called()
  with patch.dict(m.CONFIG,{'agorStaticTenant':'default'}):
   handler.headers={'Authorization':token(tenant_id=None)}
   with patch.object(m.urllib.request,'urlopen',return_value=io.BytesIO(json.dumps({'user_id':uid,'role':'superadmin'}).encode())):
    self.assertIsNotNone(handler.session())
   handler.headers={'Authorization':token(tenant_id='other')}
   with patch.object(m.urllib.request,'urlopen') as call:
    self.assertIsNone(handler.session());call.assert_not_called()
  handler.headers={'Authorization':token()}
  with patch.object(m.urllib.request,'urlopen',side_effect=urllib.error.URLError('revoked')):
   self.assertIsNone(handler.session())
 def test_failed_transfer_retains_holds(self):
  m=self.module;op={'id':'test','status':'queued','steps':[]};m.operation_lock.acquire()
  def rpc(origin,route,payload=None,timeout=12):
   if route=='/ops/export':raise RuntimeError('conflict')
   return {'held':True}
  with patch.object(m,'rpc',side_effect=rpc) as call:
   m.transfer(op,{'origin':'a'},{'origin':'b'},'tenant-a','branch-a')
   self.assertEqual(op['status'],'failed');self.assertFalse(any(c.args[1]=='/ops/release' for c in call.call_args_list));self.assertFalse(m.operation_lock.locked())
 def test_newer_copy_is_not_overwritten_by_retained_source(self):
  m=self.module;op={'id':'newer-copy','status':'queued','steps':[]};m.operation_lock.acquire()
  def rpc(origin,route,payload=None,timeout=12):
   if route=='/ops/status':return {'residents':[{'tenantId':'tenant-a','branchId':'branch-a','resident':True,'epoch':2,'lastUsed':10 if origin=='b' else 5}]}
   return {}
  with patch.object(m,'rpc',side_effect=rpc) as call:
   m.transfer(op,{'origin':'a'},{'origin':'b'},'tenant-a','branch-a')
   self.assertEqual(op['status'],'failed');self.assertIn('most recently used',op['detail'])
   self.assertFalse(any(c.args[1]=='/ops/export' for c in call.call_args_list))
 def test_all_registered_workers_held_before_export(self):
  m=self.module;op={'id':'all-held','status':'queued','steps':[]};m.operation_lock.acquire();held=set()
  def rpc(origin,route,payload=None,timeout=12):
   if route=='/ops/hold':held.add(origin);return {}
   if route=='/ops/status':return {'residents':[{'tenantId':'tenant-a','branchId':'branch-a','resident':True,'epoch':2,'lastUsed':10}]} if origin=='a' else {'residents':[]}
   if route=='/ops/export':self.assertEqual(held,{'a','b','c'});return {'hash':'snapshot','epoch':3,'repository':'repo'}
   if route=='/ops/import':return {'sessions':1}
   if route=='/ops/release':held.remove(origin);return {}
  with patch.object(m,'rpc',side_effect=rpc):m.transfer(op,{'origin':'a'},{'origin':'b'},'tenant-a','branch-a',[{'origin':x} for x in ['a','b','c']])
  self.assertEqual(op['status'],'complete');self.assertEqual(held,set())
if __name__=='__main__':unittest.main()

