import {test,expect} from 'bun:test';
import {mkdtempSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {SyncStore} from './sync-store';
import {RetailRequestSchema} from '../operations';
const config={name:'测试店铺',mode:'fixture',shopId:'',appKey:'',fixture:'normal'};
test('an archived task remains addressable after the recent fifty-task window',()=>{
 const dir=mkdtempSync(join(tmpdir(),'merqo-sync-history-')),s=new SyncStore(join(dir,'sync.sqlite'));try{s.request({op:'sync_store_configure',expectedRevision:0,config});s.request({op:'sync_store_check',expectedRevision:1,ok:true,message:'fixture'});let first='';for(let i=0;i<52;i++){const j=s.request({op:'sync_store_create',expectedRevision:1,window:{start:1700000000,end:1700000100,size:100}}).jobs[0]!;if(!i)first=j.id;const running=claim(s,j.id);page(s,j.id,running.epoch,0,0,0);}expect(s.view().jobs.some(j=>j.id===first)).toBe(false);expect(s.request({op:'sync_store_job',id:first}).jobs[0]?.id).toBe(first);}finally{s.close();rmSync(dir,{recursive:true,force:true});}
});
function setup(){const dir=mkdtempSync(join(tmpdir(),'merqo-sync-'));const file=join(dir,'sync.sqlite');let now=1700001000000;const store=new SyncStore(file,()=>now);store.request({op:'sync_store_configure',expectedRevision:0,config});store.request({op:'sync_store_check',expectedRevision:1,ok:true,message:'合成演练'});const create=()=>store.request({op:'sync_store_create',expectedRevision:1,window:{start:1700000000,end:1700000100,size:2}}).jobs[0]!;return{dir,file,store,create,tick:(ms:number)=>{now+=ms;}};}
function claim(store:SyncStore,id:string){const j=store.view().jobs.find(j=>j.id===id)!;return store.request({op:'sync_store_claim',id,expectedEpoch:j.epoch}).jobs.find(j=>j.id===id)!;}
function page(store:SyncStore,id:string,epoch:number,page:number,count:number,total=3){return store.request({op:'sync_store_page',id,expectedEpoch:epoch,page,count,reportedTotal:total,responseSha256:'a'.repeat(64),encrypted:'{"v":1,"data":"ciphertext-only"}'});}

test('page staging and checkpoint commit together; pause fences late results, restart preserves pages and requires resume',()=>{
 const f=setup();let second:SyncStore|undefined;
 try{
  const initial=f.create();expect(()=>f.create()).toThrow('已有');const first=claim(f.store,initial.id);
  page(f.store,first.id,first.epoch,0,2);const next=f.store.view().jobs[0]!;expect(next).toMatchObject({received:2,nextPage:1,status:'queued'});
  expect(()=>page(f.store,first.id,first.epoch,0,2)).toThrow('版本');expect(f.store.view().receipts[first.id]).toHaveLength(1);
  const running=claim(f.store,first.id);const paused=f.store.request({op:'sync_store_control',id:first.id,expectedEpoch:running.epoch,action:'pause'}).jobs[0]!;
  expect(()=>page(f.store,first.id,running.epoch,1,1)).toThrow('版本');expect(paused.nextPage).toBe(1);
  f.store.request({op:'sync_store_control',id:first.id,expectedEpoch:paused.epoch,action:'resume'});claim(f.store,first.id);
  second=new SyncStore(f.file,()=>1700001001000);const recovered=second.request({op:'sync_store_recover'}).jobs[0]!;expect(recovered).toMatchObject({status:'paused',received:2,nextPage:1});
  second.request({op:'sync_store_control',id:first.id,expectedEpoch:recovered.epoch,action:'resume'});const resumed=claim(second,first.id);page(second,first.id,resumed.epoch,1,1);
  expect(second.view().jobs[0]).toMatchObject({status:'fetched',received:3,nextPage:2});expect(second.view().receipts[first.id]).toHaveLength(2);
  expect(JSON.stringify(second.view())).not.toContain('ciphertext-only');
 }finally{second?.close();f.store.close();rmSync(f.dir,{recursive:true,force:true});}
});
test('transient failure uses bounded retries on the same page; permanent failure requires an explicit retry',()=>{
 const f=setup();try{
  const j=f.create();for(let attempt=1;attempt<=3;attempt++){
   const running=claim(f.store,j.id);const failed=f.store.request({op:'sync_store_failure',id:j.id,expectedEpoch:running.epoch,message:'HTTP 429',retryable:true}).jobs[0]!;
   expect(failed.nextPage).toBe(0);expect(failed.received).toBe(0);expect(failed.attempts).toBe(attempt);
   if(attempt<3){expect(failed.status).toBe('retry_wait');expect(()=>claim(f.store,j.id)).toThrow('时间');f.tick(4000);}else expect(failed.status).toBe('failed');
  }
  const failed=f.store.view().jobs[0]!;f.store.request({op:'sync_store_control',id:j.id,expectedEpoch:failed.epoch,action:'retry'});
  const running=claim(f.store,j.id);f.store.request({op:'sync_store_failure',id:j.id,expectedEpoch:running.epoch,message:'授权失效',retryable:false,blocked:true});expect(f.store.view().jobs[0]?.status).toBe('blocked');
 }finally{f.store.close();rmSync(f.dir,{recursive:true,force:true});}
});
test('invalid or changing page totals do not stage a page or advance checkpoints; config changes invalidate old tasks',()=>{
 const f=setup();try{
  const j=f.create(),first=claim(f.store,j.id);page(f.store,j.id,first.epoch,0,2,4);const next=claim(f.store,j.id);
  for(const [pageNumber,count,total] of [[0,2,4],[1,2,5],[1,0,4],[1,3,4]])expect(()=>page(f.store,j.id,next.epoch,pageNumber!,count!,total!)).toThrow();
  expect(f.store.view().jobs[0]).toMatchObject({received:2,nextPage:1,status:'running'});expect(f.store.view().receipts[j.id]).toHaveLength(1);
  f.store.request({op:'sync_store_configure',expectedRevision:1,config:{...config,name:'修改配置'}});expect(f.store.view().jobs[0]?.status).toBe('blocked');
  expect(()=>page(f.store,j.id,next.epoch,1,2,4)).toThrow('版本');
 }finally{f.store.close();rmSync(f.dir,{recursive:true,force:true});}
});
test('authorization, time windows and renderer boundary prevent forged transport updates',()=>{
 const f=setup();try{
  expect(()=>f.store.request({op:'sync_store_configure',expectedRevision:1,config:{...config,mode:'live',appKey:'app',shopId:'shop'}})).toThrow('有效授权');
  expect(()=>f.store.request({op:'sync_store_create',expectedRevision:1,window:{start:1700000000,end:1700200000,size:2}})).toThrow();
  for(const input of [{op:'sync_store_claim',id:crypto.randomUUID(),expectedEpoch:0},{op:'sync_create',expectedRevision:1,window:{start:1,end:2,size:2},workspaceId:'other'},{op:'sync_configure',expectedRevision:1,config:{...config,endpoint:'https://attacker.example'}}])expect(RetailRequestSchema.safeParse(input).success).toBe(false);
  expect(RetailRequestSchema.safeParse({op:'sync_view'}).success).toBe(true);
  f.store.request({op:'sync_store_configure',expectedRevision:1,config:{...config,mode:'live',appKey:'app',shopId:'shop'},credentialRef:crypto.randomUUID(),expiresAt:1700001000100});f.store.request({op:'sync_store_check',expectedRevision:2,ok:true,message:'接口可读'});f.tick(200);
  expect(()=>f.store.request({op:'sync_store_create',expectedRevision:2,window:{start:1700000000,end:1700000100,size:2}})).toThrow('过期');
 }finally{f.store.close();rmSync(f.dir,{recursive:true,force:true});}
});
