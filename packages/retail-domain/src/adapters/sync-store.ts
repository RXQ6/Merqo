import {Database} from 'bun:sqlite';
import {SyncScheduleStore} from './sync-schedule';
import {mkdirSync} from 'node:fs';
import {dirname} from 'node:path';
import {SyncInternalSchema,type SyncConnection,type SyncJob,type SyncView,type SyncPageReceipt} from './sync-contract';

/** One workspace per database. Page staging and checkpoint advance share one transaction. */
export class SyncStore {
 private db:Database;
 private schedule:SyncScheduleStore;
 constructor(file:string,private now=Date.now){
  mkdirSync(dirname(file),{recursive:true});this.db=new Database(file,{create:true,strict:true});
  this.db.exec(`PRAGMA busy_timeout=5000;PRAGMA journal_mode=WAL;
   CREATE TABLE IF NOT EXISTS sync_connection(id INTEGER PRIMARY KEY CHECK(id=1),json TEXT NOT NULL);
   CREATE TABLE IF NOT EXISTS sync_jobs(id TEXT PRIMARY KEY,json TEXT NOT NULL);
   CREATE TABLE IF NOT EXISTS sync_pages(job_id TEXT NOT NULL,page INTEGER NOT NULL,receipt TEXT NOT NULL,encrypted TEXT NOT NULL,PRIMARY KEY(job_id,page));
   CREATE INDEX IF NOT EXISTS sync_job_status_created ON sync_jobs(json_extract(json,'$.status'),json_extract(json,'$.createdAt'));`);
  this.schedule=new SyncScheduleStore(this.db,this.now,()=>this.connection(),()=>this.jobs(),j=>this.save(j));
 }
 close(){this.db.close();}
 staging(id:string){const job=this.job(id);if(job.stagingPurgedAt)throw Error('加密暂存已按清理回执清空，请重新拉取；原入库及对账回执仍保留');if(job.status!=='fetched')throw Error('只有拉取结束的任务可以映射');const bytes=this.db.query<{n:number},[string]>('SELECT COALESCE(SUM(length(encrypted)),0) AS n FROM sync_pages WHERE job_id=?').get(id)!.n;if(bytes>24000000)throw Error('暂存批次超过24MB映射预览限制，请缩小窗口');const pages=this.db.query<{page:number;receipt:string;encrypted:string},[string]>('SELECT page,receipt,encrypted FROM sync_pages WHERE job_id=? ORDER BY page').all(id);if(pages.length!==job.nextPage)throw Error('暂存分页不完整');return{job,pages};}
 connection():SyncConnection|null {const row=this.db.query<{json:string},[]>('SELECT json FROM sync_connection WHERE id=1').get();return row?JSON.parse(row.json):null;}
 private jobs():SyncJob[]{return this.db.query<{json:string},[]>('SELECT json FROM sync_jobs ORDER BY rowid DESC LIMIT 50').all().map(r=>JSON.parse(r.json));}
 private job(id:string):SyncJob {const row=this.db.query<{json:string},[string]>('SELECT json FROM sync_jobs WHERE id=?').get(id);if(!row)throw Error('同步任务不存在');return JSON.parse(row.json);}
 private save(job:SyncJob){job.updatedAt=this.now();this.db.query('INSERT INTO sync_jobs(id,json) VALUES(?,?) ON CONFLICT(id) DO UPDATE SET json=excluded.json').run(job.id,JSON.stringify(job));}
 view(selectedId?:string):SyncView {const recent=this.jobs(),jobs=selectedId?[this.job(selectedId),...recent.filter(j=>j.id!==selectedId)]:recent;const receipts:Record<string,SyncPageReceipt[]>={};for(const job of jobs)receipts[job.id]=this.db.query<{receipt:string},[string]>('SELECT receipt FROM sync_pages WHERE job_id=? ORDER BY page DESC LIMIT 100').all(job.id).map(r=>JSON.parse(r.receipt));return{connection:this.connection(),jobs,receipts,schedule:this.schedule.view()};}
 private requireConnection(revision:number):SyncConnection {const c=this.connection();if(!c||c.revision!==revision)throw Error('连接配置已变化，请刷新');return c;}
 private ready(c:SyncConnection){if(!c.check?.ok)throw Error('请先完成连接检查');if(c.mode==='live'&&(!c.credentialRef||!c.expiresAt||c.expiresAt<=this.now()))throw Error('授权已过期，请重新配置授权');}
 request(input:unknown):SyncView {
  const r=SyncInternalSchema.parse(input);
  return this.db.transaction(()=>{
   if(r.op==='sync_store_view')return this.view();
   if(r.op==='sync_store_job')return this.view(r.id);
   if(r.op==='sync_store_schedule_configure'){this.schedule.configure(r.expectedRevision,r.config);}
   else if(r.op==='sync_store_schedule_tick'){this.schedule.tick(r.expectedRevision);}
   else if(r.op==='sync_store_configure'){
    const old=this.connection();if((old?.revision??0)!==r.expectedRevision)throw Error('配置版本已变化，请刷新');
    if(r.config.mode==='live'&&(!r.credentialRef||!r.expiresAt||r.expiresAt<=this.now()))throw Error('请提供有效授权和到期时间');
    this.schedule.invalidate();
    const next:SyncConnection={...r.config,revision:r.expectedRevision+1,...(r.config.mode==='live'?{credentialRef:r.credentialRef!,expiresAt:r.expiresAt!}:{})};
    this.db.query('INSERT INTO sync_connection VALUES(1,?) ON CONFLICT(id) DO UPDATE SET json=excluded.json').run(JSON.stringify(next));
    for(const job of this.jobs())if(job.status!=='fetched'){job.status='blocked';job.epoch++;job.retryAt=null;job.error='连接配置已变化，请创建新任务';this.save(job);}
   }else if(r.op==='sync_store_check'){
    const c=this.requireConnection(r.expectedRevision);c.check={ok:r.ok,at:this.now(),message:r.message};this.db.query('UPDATE sync_connection SET json=? WHERE id=1').run(JSON.stringify(c));
   }else if(r.op==='sync_store_create'){
    const c=this.requireConnection(r.expectedRevision);this.ready(c);if(r.window.end>Math.floor(this.now()/1000))throw Error('同步截止时间不能晚于当前时间');
    if(this.jobs().some(j=>['queued','running','retry_wait','paused'].includes(j.status)&&j.connectionRevision===c.revision))throw Error('已有未结束任务，请继续现有任务');
    const at=this.now();this.save({id:crypto.randomUUID(),connectionRevision:c.revision,mode:c.mode,scope:{shopId:c.shopId,appKey:c.appKey},window:r.window,status:'queued',epoch:0,nextPage:0,received:0,reportedTotal:null,attempts:0,retryAt:null,error:null,createdAt:at,updatedAt:at});
   }else if(r.op==='sync_store_recover'){
    for(const job of this.jobs())if(['queued','running','retry_wait'].includes(job.status)){job.status='paused';job.epoch++;job.retryAt=null;job.error='程序已重启；已保留提交断点，请手动继续';this.save(job);}
   }else {
    const job=this.job(r.id);if(job.epoch!==r.expectedEpoch&&!(r.op==='sync_store_control'&&r.action==='pause'))throw Error('任务版本已变化，请刷新');
    if(r.op==='sync_store_control'){
     if(r.action==='pause'){
      if(job.status==='paused')return this.view();
      if(!['queued','running','retry_wait'].includes(job.status))throw Error('当前任务不能暂停');job.status='paused';
     }else{
      const c=this.requireConnection(job.connectionRevision);this.ready(c);
      if(job.nextPage>=100)throw Error('已达到100页上限，请缩小窗口创建新任务');
      if(r.action==='resume'&&job.status!=='paused'||r.action==='retry'&&!['failed','blocked'].includes(job.status))throw Error('当前任务不能继续或重试');
      job.status='queued';job.attempts=0;
     }
     job.epoch++;job.retryAt=null;job.error=null;this.save(job);
    }else if(r.op==='sync_store_claim'){
     if(job.status!=='queued'&&!(job.status==='retry_wait'&&(job.retryAt??Infinity)<=this.now()))throw Error('任务尚未到可执行时间');
     const c=this.requireConnection(job.connectionRevision);this.ready(c);job.status='running';job.epoch++;job.retryAt=null;this.save(job);
    }else{
     if(job.status!=='running'&&!(r.op==='sync_store_failure'&&r.blocked&&['queued','retry_wait'].includes(job.status)))throw Error('任务不在执行中');
     if(r.op==='sync_store_failure'){
      job.attempts++;job.error=r.message;
      job.status=r.blocked?'blocked':r.retryable&&job.attempts<3?'retry_wait':'failed';
      job.retryAt=job.status==='retry_wait'?this.now()+1000*2**(job.attempts-1):null;this.save(job);
     }else if(r.op==='sync_store_page'){
      if(r.page!==job.nextPage||r.count>job.window.size||r.count>r.reportedTotal)throw Error('响应页与断点不一致');
      if(job.reportedTotal!==null&&job.reportedTotal!==r.reportedTotal)throw Error('分页期间总数变化，请缩小窗口重新拉取');
      const received=job.received+r.count;
      if(received>r.reportedTotal||r.count===0&&received<r.reportedTotal)throw Error('分页数量不一致，不能推进断点');
      const receipt:SyncPageReceipt={page:r.page,count:r.count,responseSha256:r.responseSha256,at:this.now()};
      this.db.query('INSERT INTO sync_pages VALUES(?,?,?,?)').run(job.id,r.page,JSON.stringify(receipt),r.encrypted);
      job.nextPage++;job.received=received;job.reportedTotal=r.reportedTotal;job.attempts=0;job.error=null;
      job.status=received===r.reportedTotal?'fetched':job.nextPage>=100?'failed':'queued';
      if(job.status==='failed')job.error='已达到100页上限，请缩小时间窗口';
      job.retryAt=null;job.epoch++;this.save(job);if(job.status==='fetched')this.schedule.complete(job);
     }
    }
   }
   return this.view();
  }).immediate();
 }
}
