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
  self.assertEqual(self.request('/ops/api/login',{'username':'matt','password':'test-password'}).status,403)
  login=self.request('/ops/api/login',{'username':'matt','password':'test-password'},{'Origin':'https://ops.test'})
  self.assertEqual(login.status,200);cookie=login.headers['Set-Cookie'];self.assertIn('HttpOnly',cookie);self.assertIn('Secure',cookie)
  headers={'Cookie':cookie.split(';')[0],'Origin':'https://ops.test'}
  self.assertEqual(self.request('/ops/api/provision',{},headers).status,403)
  data=json.load(self.request('/ops/api/state',headers=headers));headers['X-Ops-CSRF']=data['csrf']
  self.assertEqual(self.request('/ops/api/transfer',{'source':'injected-host','target':'other','tenant':'other-tenant','branch':'x'},headers).status,409)
  self.assertEqual(self.request('/ops/api/logout',{},headers).status,200)
  self.assertEqual(self.request('/ops/api/state',headers=headers).status,401)
 def test_failed_transfer_retains_holds(self):
  m=self.module;op={'id':'test','status':'queued','steps':[]};m.operation_lock.acquire()
  def rpc(origin,route,payload=None,timeout=12):
   if route=='/ops/export':raise RuntimeError('conflict')
   return {'held':True}
  with patch.object(m,'rpc',side_effect=rpc) as call:
   m.transfer(op,{'origin':'a'},{'origin':'b'},'tenant-a','branch-a')
   self.assertEqual(op['status'],'failed');self.assertFalse(any(c.args[1]=='/ops/release' for c in call.call_args_list));self.assertFalse(m.operation_lock.locked())
if __name__=='__main__':unittest.main()
