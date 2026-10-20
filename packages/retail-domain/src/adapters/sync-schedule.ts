import type {Database} from 'bun:sqlite';
import type {SyncConnection,SyncJob} from './sync-contract';
import {SyncScheduleConfigSchema,type SyncScheduleConfig,type SyncSchedule} from './sync-schedule-contract';

/** Shares the page-commit transaction: cursor means fetched transport, never business completeness. */
export class SyncScheduleStore {
 constructor(private db:Database,private now:()=>number,private connection:()=>SyncConnection|null,private jobs:()=>SyncJob[],private saveJob:(job:SyncJob)=>void){db.exec('CREATE TABLE IF NOT EXISTS sync_schedule(id INTEGER PRIMARY KEY CHECK(id=1),json TEXT NOT NULL)');}
 view():SyncSchedule|null {const row=this.db.query<{json:string},[]>('SELECT json FROM sync_schedule WHERE id=1').get();if(!row)return null;const s=JSON.parse(row.json) as SyncSchedule;return{...s,backlogSeconds:Math.max(0,Math.floor(this.now()/1000)-s.config.delaySeconds-s.cursor)};}
 private save(s:SyncSchedule){this.db.query('INSERT INTO sync_schedule VALUES(1,?) ON CONFLICT(id) DO UPDATE SET json=excluded.json').run(JSON.stringify(s));}
 configure(expectedRevision:number,input:SyncScheduleConfig){
  const config=SyncScheduleConfigSchema.parse(input),old=this.view(),connection=this.connection();
  if((old?.revision??0)!==expectedRevision)throw Error('增量计划版本已变化，请刷新');
  if(!connection)throw Error('请先配置连接');
  if(config.startFrom>Math.floor(this.now()/1000)-config.delaySeconds)throw Error('增量起点须早于当前时间减安全延迟');
  if(config.enabled)this.ready(connection);
  const samePlan=old&&old.connectionRevision===connection.revision&&JSON.stringify({...old.config,enabled:false})===JSON.stringify({...config,enabled:false});
  if(old?.pendingJobId&&!samePlan)throw Error('增量任务尚未结束，请先完成该任务；可以仅停用计划');
  this.save(samePlan?{...old,revision:expectedRevision+1,config,error:null}:{revision:expectedRevision+1,connectionRevision:connection.revision,config,cursor:config.startFrom,pendingJobId:null,nextRunAt:this.now(),lastCompletedAt:null,error:null,backlogSeconds:0});
 }
 private ready(c:SyncConnection){if(!c.check?.ok)throw Error('请先完成只读连接检查');if(c.mode==='live'&&(!c.credentialRef||!c.expiresAt||c.expiresAt<=this.now()))throw Error('授权已过期或不可用，请更新连接');}
 invalidate(){const s=this.view();if(s){s.config.enabled=false;s.pendingJobId=null;s.error='连接配置已变化，增量计划已停用；请核对新连接并重新保存计划';this.save(s);}}
 tick(expectedRevision?:number){
  const s=this.view();if(expectedRevision!==undefined&&s?.revision!==expectedRevision)throw Error('增量计划版本已变化，请刷新');
  if(!s||!s.config.enabled)return;
  if(s.pendingJobId)return;
  if(expectedRevision===undefined&&s.nextRunAt>this.now())return;
  try{
   const c=this.connection();if(!c||c.revision!==s.connectionRevision)throw Error('连接已变化，请重新配置增量计划');this.ready(c);
   if(this.jobs().some(j=>j.connectionRevision===c.revision&&['queued','running','retry_wait','paused'].includes(j.status))){s.error='已有未结束任务，增量计划等待该任务结束';this.save(s);return;}
   const target=Math.floor(this.now()/1000)-s.config.delaySeconds;
   if(target<=s.cursor){s.nextRunAt=this.now()+s.config.intervalMinutes*60000;s.error=null;this.save(s);return;}
   const end=Math.min(target,s.cursor+s.config.maxWindowSeconds-s.config.overlapSeconds),at=this.now();
   const job:SyncJob={id:crypto.randomUUID(),connectionRevision:c.revision,mode:c.mode,scope:{shopId:c.shopId,appKey:c.appKey},window:{start:Math.max(1,s.cursor-s.config.overlapSeconds),end,size:s.config.size},status:'queued',epoch:0,nextPage:0,received:0,reportedTotal:null,attempts:0,retryAt:null,error:null,createdAt:at,updatedAt:at,incremental:{scheduleRevision:s.revision,from:s.cursor,to:end}};
   this.saveJob(job);s.pendingJobId=job.id;s.error=null;this.save(s);
  }catch(error){s.error=error instanceof Error?error.message:'增量计划未执行';this.save(s);}
 }
 complete(job:SyncJob){const s=this.view();if(!s||s.pendingJobId!==job.id||job.status!=='fetched'||!job.incremental)return;if(s.connectionRevision!==job.connectionRevision||s.cursor!==job.incremental.from)throw Error('增量游标与任务不一致');s.cursor=job.incremental.to;s.pendingJobId=null;s.lastCompletedAt=this.now();s.nextRunAt=this.now()+s.config.intervalMinutes*60000;s.error=null;this.save(s);}
}
