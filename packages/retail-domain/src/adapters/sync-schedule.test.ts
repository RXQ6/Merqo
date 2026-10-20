import {test,expect} from 'bun:test';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {SyncStore} from './sync-store';
import {RetailRequestSchema} from '../operations';
function setup(){const dir=mkdtempSync(join(tmpdir(),'merqo-incremental-')),file=join(dir,'sync.sqlite');let now=1700100000000;const store=new SyncStore(file,()=>now);store.request({op:'sync_store_configure',expectedRevision:0,config:{name:'演练',mode:'fixture',shopId:'',appKey:'',fixture:'normal'}});store.request({op:'sync_store_check',expectedRevision:1,ok:true,message:'fixture'});const config={enabled:true,intervalMinutes:5,overlapSeconds:300,delaySeconds:300,maxWindowSeconds:3600,startFrom:1700000000,size:100};const configure=()=>store.request({op:'sync_store_schedule_configure',expectedRevision:0,config});return{dir,file,store,config,configure,tick:(ms:number)=>now+=ms,close(){store.close();rmSync(dir,{recursive:true,force:true});}};}
function finish(store:SyncStore){let j=store.view().jobs[0]!;if(j.status==='paused')store.request({op:'sync_store_control',id:j.id,expectedEpoch:j.epoch,action:'resume'});j=store.request({op:'sync_store_claim',id:j.id,expectedEpoch:store.view().jobs[0]!.epoch}).jobs[0]!;return store.request({op:'sync_store_page',id:j.id,expectedEpoch:j.epoch,page:0,count:0,reportedTotal:0,responseSha256:'a'.repeat(64),encrypted:'ciphertext'});}
test('incremental cursor advances only with page commit, overlap repeats and closed-app backlog is never skipped',()=>{
 const f=setup();try{f.configure();let v=f.store.request({op:'sync_store_schedule_tick'});expect(v.schedule?.cursor).toBe(f.config.startFrom);expect(v.jobs[0]?.window).toMatchObject({start:f.config.startFrom-300,end:f.config.startFrom+3300});f.store.request({op:'sync_store_schedule_tick'});expect(f.store.view().jobs).toHaveLength(1);
 v=finish(f.store);expect(v.schedule?.cursor).toBe(f.config.startFrom+3300);expect(v.schedule?.pendingJobId).toBeNull();expect(f.store.request({op:'sync_store_schedule_tick'}).jobs).toHaveLength(1);
 f.tick(3*86400000);v=f.store.request({op:'sync_store_schedule_tick'});expect(v.jobs[0]?.window.start).toBe(f.config.startFrom+3300-300);expect(v.jobs[0]?.window.end).toBe(f.config.startFrom+6600);expect(v.schedule!.backlogSeconds).toBeGreaterThan(3*86400);expect(v.schedule?.cursor).toBe(f.config.startFrom+3300);
 }finally{f.close();}
});
test('restart pauses pending job; disabled plan may finish that job but never queues another',()=>{
 const f=setup();let other:SyncStore|undefined;try{f.configure();const j=f.store.request({op:'sync_store_schedule_tick'}).jobs[0]!;other=new SyncStore(f.file);other.request({op:'sync_store_recover'});expect(other.view().jobs[0]?.status).toBe('paused');expect(other.view().schedule?.cursor).toBe(f.config.startFrom);
 const current=f.store.view().schedule!;expect(()=>f.store.request({op:'sync_store_schedule_configure',expectedRevision:current.revision,config:{...f.config,startFrom:f.config.startFrom+100}})).toThrow('尚未结束');
 f.store.request({op:'sync_store_schedule_configure',expectedRevision:current.revision,config:{...f.config,enabled:false}});expect(f.store.request({op:'sync_store_schedule_tick'}).jobs[0]?.id).toBe(j.id);finish(f.store);f.tick(86400000);expect(f.store.request({op:'sync_store_schedule_tick'}).jobs).toHaveLength(1);expect(f.store.view().schedule?.cursor).toBe(f.config.startFrom+3300);
 }finally{other?.close();f.close();}
});
test('configuration changes disable old plans; wrong revisions, future start and internal renderer ticks are rejected',()=>{
 const f=setup();try{f.configure();expect(()=>f.store.request({op:'sync_store_schedule_tick',expectedRevision:2})).toThrow('版本');expect(()=>f.store.request({op:'sync_store_schedule_configure',expectedRevision:1,config:{...f.config,startFrom:1900000000}})).toThrow('起点');
 f.store.request({op:'sync_store_configure',expectedRevision:1,config:{name:'新连接',mode:'fixture',shopId:'',appKey:'',fixture:'normal'}});expect(f.store.view().schedule?.config.enabled).toBe(false);expect(f.store.request({op:'sync_store_schedule_tick'}).jobs).toHaveLength(0);expect(RetailRequestSchema.safeParse({op:'sync_store_schedule_tick'}).success).toBe(false);
 }finally{f.close();}
});
test('failure never advances cursor or creates a replacement task; explicit retry keeps the same window',()=>{
 const f=setup();try{f.configure();let j=f.store.request({op:'sync_store_schedule_tick'}).jobs[0]!;j=f.store.request({op:'sync_store_claim',id:j.id,expectedEpoch:j.epoch}).jobs[0]!;f.store.request({op:'sync_store_failure',id:j.id,expectedEpoch:j.epoch,message:'HTTP 403',retryable:false,blocked:true});f.tick(86400000);expect(f.store.request({op:'sync_store_schedule_tick'}).jobs).toHaveLength(1);expect(f.store.view().schedule?.cursor).toBe(f.config.startFrom);
 const failed=f.store.view().jobs[0]!;f.store.request({op:'sync_store_control',id:failed.id,expectedEpoch:failed.epoch,action:'retry'});expect(f.store.view().jobs[0]?.window).toEqual(j.window);finish(f.store);expect(f.store.view().schedule?.cursor).toBe(f.config.startFrom+3300);
 }finally{f.close();}
});
