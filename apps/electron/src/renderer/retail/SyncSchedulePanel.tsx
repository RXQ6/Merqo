import {useState} from 'react';
import type {SyncView} from '../../../../../packages/retail-domain/src/adapters/sync-contract';
import {SyncScheduleConfigSchema,type SyncScheduleConfig} from '../../../../../packages/retail-domain/src/adapters/sync-schedule-contract';
import type {RetailRequest} from '../../../../../packages/retail-domain/src/operations';
const local=(n:number)=>{if(!Number.isFinite(n))return '';const d=new Date(n*1000);return new Date(d.getTime()-d.getTimezoneOffset()*60000).toISOString().slice(0,16);};
export function SyncSchedulePanel({view,busy,send}:{view:SyncView;busy:boolean;send:(r:RetailRequest)=>Promise<unknown>}){
 const current=view.schedule;
 const [form,setForm]=useState<SyncScheduleConfig>(()=>current?.config??{enabled:false,intervalMinutes:30,overlapSeconds:300,delaySeconds:300,maxWindowSeconds:86400,startFrom:Math.floor(Date.now()/1000)-3600,size:50}),[error,setError]=useState('');
 async function save(){const p=SyncScheduleConfigSchema.safeParse(form);if(!p.success){setError(p.error.issues.map(i=>i.message).join('；'));return;}setError('');await send({op:'sync_schedule_configure',expectedRevision:current?.revision??0,config:p.data});}
 return <section className="retail-panel" aria-label="自动增量同步"><div className="retail-sync-form"><h2>自动增量同步与补拉</h2><p>仅在应用运行时按分钟检查计划。关闭期间不拉取；重开后从保留的位置补拉，不跳过缺口。自动同步仅加密暂存，不自动入库。</p>
 {error&&<p role="alert">{error}</p>}
 <label className="retail-checkbox"><input type="checkbox" aria-label="启用自动增量同步" checked={form.enabled} onChange={e=>setForm({...form,enabled:e.target.checked})}/>启用自动增量同步</label>
 <label>首次拉取起点（本机时区；修改并保存会重置位置）<input aria-label="增量首次起点" type="datetime-local" value={local(form.startFrom)} onChange={e=>setForm({...form,startFrom:Math.floor(new Date(e.target.value).getTime()/1000)})}/></label>
 <div className="retail-ingest-columns">{([{key:'intervalMinutes',label:'检查间隔（分钟）',min:5,max:1440},{key:'overlapSeconds',label:'重叠补拉（秒）',min:0,max:3600},{key:'delaySeconds',label:'安全延迟（秒）',min:60,max:86400},{key:'maxWindowSeconds',label:'每窗上限（秒）',min:300,max:86400},{key:'size',label:'增量每页条数',min:1,max:100}] as const).map(f=><label key={f.key}>{f.label}<input aria-label={f.label} type="number" min={f.min} max={f.max} value={form[f.key]} onChange={e=>setForm({...form,[f.key]:Number(e.target.value)})}/></label>)}</div>
 <button disabled={busy||form.enabled&&!view.connection?.check?.ok} onClick={()=>void save()}>保存增量计划</button>
 {current&&<><p role="status">计划 v{current.revision} · {current.config.enabled?'已启用':'已停用'} · 传输已拉取截止 {new Date(current.cursor*1000).toLocaleString()} · 尚待补拉约 {current.backlogSeconds} 秒</p><p>该截止位置只表示分页取得，不证明支付、售后或业务入库完整。下一次检查 {new Date(current.nextRunAt).toLocaleString()}。</p>{current.error&&<p className="retail-warning">{current.error}</p>}{current.pendingJobId&&<p>等待任务 {current.pendingJobId} 完成。暂停、失败或授权问题请在下方对应任务处理，位置不会提前推进。</p>}<button disabled={busy||!current.config.enabled||!!current.pendingJobId} onClick={()=>void send({op:'sync_schedule_run',expectedRevision:current.revision})}>立即补拉一窗</button></>}
 </div></section>;
}
