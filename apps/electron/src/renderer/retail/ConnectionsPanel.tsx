import {useCallback,useEffect,useRef,useState} from 'react';
import type {RetailRequest} from '../../../../../packages/retail-domain/src/operations';
import type {SyncView,SyncConfig,SyncJob} from '../../../../../packages/retail-domain/src/adapters/sync-contract';

const labels:Record<SyncJob['status'],string>={queued:'等待执行',running:'正在拉取',retry_wait:'等待自动重试',paused:'已暂停',blocked:'需处理授权或配置',failed:'失败，断点已保留',fetched:'拉取结束 · 待映射'};
const localTime=(time:number)=>{const date=new Date(time);return new Date(time-date.getTimezoneOffset()*60000).toISOString().slice(0,16);};
export function ConnectionsPanel(){
 const [view,setView]=useState<SyncView|null>(null),[step,setStep]=useState(1),[busy,setBusy]=useState(false),[error,setError]=useState('');
 const [config,setConfig]=useState<SyncConfig>({name:'抖店连接',mode:'fixture',shopId:'',appKey:'',fixture:'normal'});
 const [secret,setSecret]=useState(''),[token,setToken]=useState(''),[expiry,setExpiry]=useState('');
 const [start,setStart]=useState(()=>localTime(Date.now()-3600000)),[end,setEnd]=useState(()=>localTime(Date.now()-60000)),[size,setSize]=useState(2);
 const hydrated=useRef(false),inFlight=useRef(false),alive=useRef(true),generation=useRef(0),mutating=useRef(false);
 const load=useCallback(async()=>{
  if(inFlight.current||mutating.current)return;inFlight.current=true;const current=generation.current;
  try{const r=await window.electronAPI.retailRequest({op:'sync_view'});if(!alive.current||generation.current!==current)return;if(!r.ok)throw Error(r.error);if(r.kind==='sync'){setView(r.data);if(!hydrated.current){hydrated.current=true;if(r.data.connection){setConfig(r.data.connection);setStep(r.data.connection.check?.ok?3:2);}}}}
  catch(e){if(alive.current)setError(e instanceof Error?e.message:'读取任务失败');}finally{inFlight.current=false;}
 },[]);
 useEffect(()=>{alive.current=true;void load();const timer=setInterval(()=>void load(),1000);return()=>{alive.current=false;clearInterval(timer);};},[load]);
 const send=async(input:RetailRequest)=>{
  if(mutating.current)return;mutating.current=true;generation.current++;setBusy(true);setError('');try{const r=await window.electronAPI.retailRequest(input);if(!r.ok)throw Error(r.error);if(r.kind==='sync'){setView(r.data);return r.data;}}
  catch(e){setError(e instanceof Error?e.message:'操作失败');}finally{mutating.current=false;setBusy(false);}
 };
 const save=async()=>{
  const result=await send({op:'sync_configure',expectedRevision:view?.connection?.revision??0,config:{name:config.name,mode:config.mode,shopId:config.shopId,appKey:config.appKey,fixture:config.fixture},...(config.mode==='live'?{credentials:{appSecret:secret,accessToken:token,expiresAt:new Date(expiry).getTime()}}:{})});
  setSecret('');setToken('');if(result)setStep(2);
 };
 const create=async()=>{const a=Math.floor(new Date(start).getTime()/1000),b=Math.floor(new Date(end).getTime()/1000);if(!Number.isFinite(a)||!Number.isFinite(b)||a>=b||b-a>86400||b>Date.now()/1000||!Number.isInteger(size)||size<1||size>100){setError('请选择有效的过去24小时内时间窗口，每页1至100条');return;}await send({op:'sync_create',expectedRevision:view?.connection?.revision??0,window:{start:a,end:b,size}});};
 return <div className="retail-connections" aria-label="平台接入与同步">
  <div className="retail-section-title"><div><h1>平台接入</h1><p>配置连接、检查权限，再按固定时间窗口拉取订单。</p></div><span className="retail-badge">{view?.connection?.mode==='live'?'真实只读模式':'测试演练 · 合成数据'}</span></div>
  <p className="retail-footnote">请求取得 → 加密暂存 → 字段映射 → 确认入库 → 后台对账。当前只实现前两步，未映射数据不进入经营指标。</p>
  {error&&<div role="alert" className="retail-error">{error}</div>}
  <section className="retail-panel" aria-label="抖店接入配置向导">
   <nav className="retail-sync-steps" aria-label="接入步骤">{['配置连接','只读检查','范围与任务'].map((name,i)=><button key={name} aria-current={step===i+1?'step':undefined} disabled={busy||i>0&&!view?.connection} onClick={()=>setStep(i+1)}>{i+1}. {name}</button>)}</nav>
   {step===1&&<div className="retail-sync-form">
    <label>连接名称<input aria-label="连接名称" value={config.name} onChange={e=>setConfig({...config,name:e.target.value})}/></label>
    <label>运行模式<select aria-label="运行模式" value={config.mode} onChange={e=>setConfig({...config,mode:e.target.value as SyncConfig['mode']})}><option value="fixture">测试演练（不访问平台）</option><option value="live">真实抖店只读连接</option></select></label>
    {config.mode==='fixture'?<label>演练场景<select aria-label="演练场景" value={config.fixture} onChange={e=>setConfig({...config,fixture:e.target.value as SyncConfig['fixture']})}><option value="normal">正常分页 · 7条合成记录</option><option value="rate_limit">第2页限流两次后恢复</option><option value="invalid_response">第2页响应无效 · 手动重试</option></select></label>:<>
     <p>先在抖店开放平台创建应用并取得订单只读授权。本向导不代办开户或生成 Token；凭据仅加密保存，不会回显。</p>
     <label>店铺 ID<input aria-label="店铺 ID" value={config.shopId} onChange={e=>setConfig({...config,shopId:e.target.value})}/></label>
     <label>App Key<input aria-label="App Key" value={config.appKey} onChange={e=>setConfig({...config,appKey:e.target.value})}/></label>
     <label>App Secret<input aria-label="App Secret" type="password" autoComplete="new-password" value={secret} onChange={e=>setSecret(e.target.value)}/></label>
     <label>Access Token<input aria-label="Access Token" type="password" autoComplete="new-password" value={token} onChange={e=>setToken(e.target.value)}/></label>
     <label>授权到期时间（本机时区）<input aria-label="授权到期时间" type="datetime-local" value={expiry} onChange={e=>setExpiry(e.target.value)}/></label>
    </>}
    <p>重新保存配置会使旧任务失效；请先完成或暂停当前任务。</p>
    <button className="retail-primary" disabled={busy||!config.name.trim()||config.mode==='live'&&(!secret||!token||!expiry||!config.shopId||!config.appKey)} onClick={()=>void save()}>保存并下一步</button>
   </div>}
   {step===2&&<div className="retail-sync-form"><h2>检查订单只读连接</h2><p>{view?.connection?.mode==='fixture'?'演练只校验本地流程，不代表真实授权成功。':'检查最近一分钟的一页订单。成功仅证明当前接口可读，店铺归属及数据完整性仍须核对。'}</p>
    {view?.connection?.check&&<p role="status">{view.connection.check.message} · {new Date(view.connection.check.at).toLocaleString()}</p>}
    <div className="retail-inline-actions"><button disabled={busy} onClick={()=>void send({op:'sync_check'})}>检测只读连接</button><button disabled={busy||!view?.connection?.check?.ok} onClick={()=>setStep(3)}>下一步：同步范围</button></div>
   </div>}
   {step===3&&<div className="retail-sync-form"><h2>创建分页拉取任务</h2><p>每次最多24小时、100页。原始页加密暂存于当前工作空间，只展示摘要；当前不自动映射、入库或对账。</p>
    <label>开始时间（本机时区）<input type="datetime-local" aria-label="同步开始时间" value={start} onChange={e=>setStart(e.target.value)}/></label>
    <label>截止时间（本机时区）<input type="datetime-local" aria-label="同步截止时间" value={end} onChange={e=>setEnd(e.target.value)}/></label>
    <label>每页条数<input aria-label="每页条数" type="number" min={1} max={100} value={size} onChange={e=>setSize(Number(e.target.value))}/></label>
    <button className="retail-primary" disabled={busy||!view?.connection?.check?.ok} onClick={()=>void create()}>{view?.connection?.mode==='fixture'?'开始演练拉取':'开始只读拉取'}</button>
   </div>}
  </section>
  <section className="retail-panel" aria-label="同步任务记录"><div className="retail-section-title"><div><h2>同步任务</h2><p>每页结果与断点一起提交。程序关闭后不运行，重启保留断点并等待手动继续。</p></div><button disabled={busy} onClick={()=>void load()}>刷新任务</button></div>
   {!view?.jobs.length&&<p>暂无任务。完成连接检查后创建第一次拉取。</p>}
   {view?.jobs.map(job=><article key={job.id} className="retail-sync-job" aria-label={`同步任务 ${job.id}`}>
    <div className="retail-section-title"><strong>{labels[job.status]}</strong><span>{job.mode==='fixture'?'合成演练':'真实只读'} · {new Date(job.createdAt).toLocaleString()}</span></div>
    <p>已提交 {job.nextPage} 页 · 收到 {job.received} 条（未做订单去重） · 平台声明总数 {job.reportedTotal??'未知'} · 下一页 {job.nextPage}（页码从0起）</p>
    <p>窗口 {new Date(job.window.start*1000).toLocaleString()} 至 {new Date(job.window.end*1000).toLocaleString()} · 当前页失败 {job.attempts}/3 次</p>
    {job.error&&<p className="retail-warning">{job.error}</p>}
    {job.retryAt&&<p>自动重试时间：{new Date(job.retryAt).toLocaleString()}</p>}
    {job.status==='fetched'&&<p>拉取结果已加密暂存；字段映射、业务校验、确认入库、对账均未完成。</p>}
    <div className="retail-inline-actions">
     {['queued','running','retry_wait'].includes(job.status)&&<button disabled={busy} onClick={()=>void send({op:'sync_control',id:job.id,expectedEpoch:job.epoch,action:'pause'})}>暂停任务</button>}
     {job.status==='paused'&&<button disabled={busy} onClick={()=>void send({op:'sync_control',id:job.id,expectedEpoch:job.epoch,action:'resume'})}>从断点继续</button>}
     {['failed','blocked'].includes(job.status)&&<button disabled={busy||job.connectionRevision!==view.connection?.revision} onClick={()=>void send({op:'sync_control',id:job.id,expectedEpoch:job.epoch,action:'retry'})}>重试当前页</button>}
    </div>
    {!!view.receipts[job.id]?.length&&<details><summary>已提交分页回执（{view.receipts[job.id].length}页）</summary><ul>{view.receipts[job.id].map(p=><li key={p.page}>第 {p.page} 页 · {p.count} 条 · 摘要 {p.responseSha256.slice(0,16)} · {new Date(p.at).toLocaleString()}</li>)}</ul></details>}
   </article>)}
  </section>
 </div>;
}
