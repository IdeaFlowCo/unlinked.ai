import unittest,json
import unlinked_storage_alerts as m
NOW='2026-11-11T23:00:00Z'
def make(*args,**kw):return {'subject':args[0],'kind':args[1],'problem':args[2],'state':args[3],'text':kw.get('text','')}
def output(level,at=NOW):return 'Q|'+json.dumps({'schema':1,'event':'search_log_storage','level':level,'at':at,'used_bytes':1024,'cap_bytes':2048,'query':'SECRET'})
class Tests(unittest.TestCase):
 def test_thresholds_and_projection(self):
  for level in ('normal','warning','full','low_disk','unavailable'):
   obs=m.observations(output(level),NOW,make)
   self.assertEqual(sum(o['problem'] for o in obs),int(level!='normal'))
   self.assertNotIn('SECRET',str(obs))
 def test_missing_or_stale_not_healthy(self):
  for out in ('Q|unavailable',output('normal','2020-01-01T00:00:00Z')):
   self.assertTrue(next(o for o in m.observations(out,NOW,make) if o['subject']=='querylog:unavailable')['problem'])
 def test_email_does_not_clear_disabled_sms_and_restart_is_deduplicated(self):
  state={};m.enqueue(state,'cap:g1',{'text':'capacity warning'},NOW);emails=[];texts=[]
  sendmail=lambda text:emails.append(text) or 'email:test'
  self.assertEqual(m.flush(state,NOW,lambda text:[],lambda:None,sendmail),1)
  state=json.loads(json.dumps(state));m.enqueue(state,'cap:g1',{'text':'duplicate'},NOW)
  sendtext=lambda text:texts.append(text) or ['sms:test']
  self.assertEqual(m.flush(state,NOW,sendtext,lambda:None,sendmail),0)
  m.flush(state,NOW,sendtext,lambda:None,sendmail)
  self.assertEqual(emails,['capacity warning']);self.assertEqual(texts,['capacity warning'])
 def test_channels_retry_independently(self):
  state={};m.enqueue(state,'cap:g1',{'text':'capacity warning'},NOW)
  m.flush(state,NOW,lambda text:['sms:test'],lambda:None,lambda text:None)
  self.assertIsNone(state['querylog_delivery']['cap:g1']['email_receipt'])
  self.assertEqual(m.flush(state,NOW,lambda text:self.fail('duplicate SMS'),lambda:None,lambda text:'email:test'),0)
if __name__=='__main__':unittest.main()
