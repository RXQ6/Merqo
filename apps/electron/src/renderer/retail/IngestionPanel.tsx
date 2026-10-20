import {useEffect,useState} from 'react';
import {LineReferencePanel} from './LineReferencePanel';
import type {RetailRequest} from '../../../../../packages/retail-domain/src/operations';
import type {SyncJob} from '../../../../../packages/retail-domain/src/adapters/sync-contract';
import {fixtureMapping,mappedFields,MappingProfileSchema,StatementSchema} from '../../../../../packages/retail-domain/src/adapters/ingestion-contract';
import type {IngestView,MappingProfile,ControlTotals} from '../../../../../packages/retail-domain/src/adapters/ingestion-contract';

const fields:Record<string,string>={event_id:'事件 ID',order_id:'订单 ID',line_id:'订单行 ID',shop_id:'店铺 ID',channel:'渠道',sku_id:'SKU',spec:'规格',kind:'事件类型',order_at:'原订单时间',event_at:'事件时间',quantity:'件数',amount_minor:'结算金额',allocated_discount_minor:'商家优惠',replaces_order_id:'换货原订单 ID（可选）',replaces_line_id:'换货原订单行 ID（可选）',platform_subsidy_minor:'平台补贴',currency:'币种'};
const optionalFields=['replaces_order_id','replaces_line_id'] as const;
const kinds:Record<string,string>={ordered:'下单',paid:'支付',shipped:'发货',refunded:'退款',cancelled:'取消',returned:'退货'};
const totalLabels:Record<keyof ControlTotals,string>={eventCount:'事件数',orderedQty:'下单件数',paidQty:'支付件数',refundedQty:'退款件数',paidMinor:'支付金额（分）',refundedMinor:'退款金额（分）',discountMinor:'商家优惠（分）',subsidyMinor:'平台补贴（分）'};
const emptyTotals:ControlTotals={eventCount:0,orderedQty:0,paidQty:0,refundedQty:0,paidMinor:0,refundedMinor:0,discountMinor:0,subsidyMinor:0};
const localNow=()=>{const d=new Date();return new Date(d.getTime()-d.getTimezoneOffset()*60000).toISOString().slice(0,16);};
const emptyProfile=(mode:SyncJob['mode']):MappingProfile=>({name:'事件映射',mode,eventArrayPath:null,fields:Object.fromEntries(mappedFields.map(f=>[f,''])),kindMap:{},moneyUnit:'minor_integer',timeUnit:'iso_offset',semanticsConfirmed:true});
export function IngestionPanel({job}:{job:SyncJob}){
 const [view,setView]=useState<IngestView|null>(null),[profile,setProfile]=useState<MappingProfile>(()=>emptyProfile(job.mode)),[confirmed,setConfirmed]=useState(false),[dirty,setDirty]=useState(true),[busy,setBusy]=useState(false),[error,setError]=useState('');
 const [discovered,setDiscovered]=useState<{arrays:string[];fields:string[];totalRecords:number}|null>(null),[partial,setPartial]=useState(false),[reason,setReason]=useState('');
 const [statementObservedAt,setStatementObservedAt]=useState(localNow),[statementLabel,setStatementLabel]=useState(''),[statementShop,setStatementShop]=useState(job.mode==='fixture'?'DEMO-SHOP':job.scope?.shopId??''),[statementTotals,setStatementTotals]=useState<Record<keyof ControlTotals,string>>(()=>Object.fromEntries(Object.keys(emptyTotals).map(k=>[k,''])) as Record<keyof ControlTotals,string>);
 useEffect(()=>{let alive=true;void window.electronAPI.retailRequest({op:'ingest_view',jobId:job.id}).then(r=>{if(!alive)return;if(!r.ok){setError(r.error);return;}if(r.kind==='ingestion'){setView(r.data);if(r.data.mapping?.profile.mode===job.mode){setProfile(r.data.mapping.profile);setConfirmed(true);setDirty(false);}}}).catch(e=>{if(alive)setError(String(e));});return()=>{alive=false;};},[job.id,job.mode]);
 const send=async(input:RetailRequest)=>{setBusy(true);setError('');try{const r=await window.electronAPI.retailRequest(input);if(!r.ok)throw Error(r.error);if(r.kind==='ingestion'){setView(r.data);return r.data;}if(r.kind==='ingest_fields')setDiscovered(r.data);}catch(e){setError(e instanceof Error?e.message:'操作失败');}finally{setBusy(false);}};
 const edit=(change:Partial<MappingProfile>)=>{setProfile(p=>({...p,...change}));setDirty(true);setConfirmed(false);if('eventArrayPath' in change)setDiscovered(null);};
 const preview=view?.previews.find(p=>p.jobId===job.id),receipt=view?.receipts.find(r=>r.jobId===job.id),reconciliation=receipt&&view?.reconciliations.find(r=>r.receiptId===receipt.id);
 const save=async()=>{const parsed=MappingProfileSchema.safeParse(profile);if(!parsed.success){setError(parsed.error.issues.map(i=>i.message).slice(0,5).join('；'));return;}const result=await send({op:'ingest_mapping_save',expectedRevision:view?.mapping?.revision??0,profile:parsed.data});if(result){setDirty(false);setConfirmed(true);}};
 const reconcileManual=async()=>{const parsed=StatementSchema.safeParse({label:statementLabel,shopId:statementShop,currency:'CNY',basis:'batch_event_set',observedAt:Number.isFinite(new Date(statementObservedAt).getTime())?new Date(statementObservedAt).toISOString():'',totals:Object.fromEntries(Object.entries(statementTotals).map(([k,v])=>[k,v.trim()===''?null:Number(v)]))});if(!parsed.success){setError('请填写来源名称和店铺，观测时间有效，所有合计须为非负安全整数；金额单位为分。');return;}if(receipt)await send({op:'ingest_reconcile',receiptId:receipt.id,statement:parsed.data});};
 return <section className="retail-ingestion" aria-label={`映射与入库 ${job.id}`}>
  <div className="retail-section-title"><h2>映射与入库</h2><span className="retail-badge">{job.mode==='fixture'?'合成事件演练':'人工映射 · 待平台核验'}</span></div>
  <p>字段映射 → 质量隔离与去重 → 预览 → 确认入库 → 批次对账。只有来源明确给出的交易事件可以入库，订单快照不能推断为支付或退款。</p>
  <p className="retail-footnote">本步骤写入交易账本。毛利、库存和广告仍需各自的成本、库存或广告证据，不会由订单金额自动补齐。</p>
  {error&&<p role="alert" className="retail-error">{error}</p>}
  <details open={!preview} className="retail-mapping-details"><summary>1. 字段与口径映射{view?.mapping?` · 当前全局版本 v${view.mapping.revision}`:''}</summary>
   <fieldset disabled={busy} className="retail-ingest-form">
    <p>映射版本供当前工作空间使用。修改后必须重新预览，旧预览不能直接入库。</p>
    {job.mode==='fixture'&&<button disabled={busy} onClick={()=>{setProfile(structuredClone(fixtureMapping));setDirty(true);setConfirmed(false);}}>填入演练映射</button>}
    <label>映射名称<input aria-label="映射名称" value={profile.name} onChange={e=>edit({name:e.target.value})}/></label>
    <label>事件数组路径（留空表示每条来源记录就是事件）<input aria-label="事件数组路径" list="ingest-arrays" value={profile.eventArrayPath??''} onChange={e=>edit({eventArrayPath:e.target.value||null})}/></label>
    <button disabled={busy} onClick={()=>void send({op:'ingest_inspect',jobId:job.id,eventArrayPath:profile.eventArrayPath})}>读取来源字段</button>
    {discovered&&<p role="status">共 {discovered.totalRecords} 条来源记录；抽样发现 {discovered.fields.length} 个字段。仅返回字段名，不展示原始个人信息。</p>}
    <datalist id="ingest-arrays">{discovered?.arrays.map(f=><option key={f} value={f}/>)}</datalist><datalist id="ingest-fields">{discovered?.fields.map(f=><option key={f} value={f}/>)}</datalist>
    <div className="retail-ingest-columns">
     <label>金额单位<select aria-label="映射金额单位" value={profile.moneyUnit} onChange={e=>edit({moneyUnit:e.target.value as MappingProfile['moneyUnit']})}><option value="minor_integer">整数分</option><option value="yuan_decimal">元（精确十进制字符串）</option></select></label>
     <label>时间格式<select aria-label="映射时间格式" value={profile.timeUnit} onChange={e=>edit({timeUnit:e.target.value as MappingProfile['timeUnit']})}><option value="iso_offset">ISO 时间（明确时区）</option><option value="unix_seconds">Unix 秒</option><option value="unix_millis">Unix 毫秒</option></select></label>
    </div>
    <div className="retail-table-wrap"><table aria-label="交易字段映射"><thead><tr><th>交易字段</th><th>来源字段路径（事件内）</th></tr></thead><tbody>{mappedFields.map(f=><tr key={f}><td>{fields[f]??f}<small>{f}</small></td><td><input aria-label={`映射 ${f}`} list="ingest-fields" value={profile.fields[f]??''} onChange={e=>edit({fields:Object.fromEntries(Object.entries({...profile.fields,[f]:e.target.value}).filter(([k,v])=>!(optionalFields as readonly string[]).includes(k)||v.trim()))})}/></td></tr>)}</tbody></table></div>
    <details><summary>事件类型值映射</summary><p>填写来源实际提供的枚举值。未配置的事件类型会隔离。</p>{Object.entries(kinds).map(([k,label])=><label key={k}>{label}的来源值<input aria-label={`类型映射 ${k}`} value={Object.entries(profile.kindMap).find(([,v])=>v===k)?.[0]??''} onChange={e=>{const next=Object.fromEntries(Object.entries(profile.kindMap).filter(([,v])=>v!==k));if(e.target.value)next[e.target.value]=k as MappingProfile['kindMap'][string];edit({kindMap:next});}}/></label>)}</details>
    <label className="retail-checkbox"><input type="checkbox" checked={confirmed} onChange={e=>setConfirmed(e.target.checked)}/>我已核对来源事件含义、金额口径、时间与店铺归属</label>
    <button className="retail-primary" disabled={busy||!confirmed} onClick={()=>void save()}>保存映射版本</button>
   </fieldset>
  </details>
  <div className="retail-inline-actions"><button className="retail-primary" disabled={busy||dirty||!view?.mapping||view.mapping.profile.mode!==job.mode} onClick={()=>{setPartial(false);setReason('');void send({op:'ingest_preview',jobId:job.id});}}>2. 生成入库预览</button><span>{dirty?'请先核对并保存映射':'已保存映射，可预览'}</span></div>
  {preview&&<section aria-label="入库预览">
   <h3>入库预览 · v{preview.mappingRevision}</h3><p role="status">来源 {preview.totalRecords} 条 · 新事件 {preview.newEvents} 条 · 重复 {preview.duplicateEvents} 条 · 冲突 {preview.conflictEvents} 条 · 隔离 {preview.quarantinedRecords} 条来源记录</p>
   <p>预览时间 {new Date(preview.createdAt).toLocaleString()} · 摘要 {preview.reviewHash.slice(0,16)} · {preview.source==='demo'?'演示账本':'CSV 交易账本（人工声明来源）'}</p>
   {preview.blockingIssues.map((issue,i)=><p key={i} className="retail-error">{issue}</p>)}
   {preview.quarantine.length>0&&<div className="retail-table-wrap"><table aria-label="隔离记录"><caption>隔离问题（最多100项；任一子事件错误会隔离整条来源记录）</caption><thead><tr><th>来源记录序号</th><th>事件序号</th><th>问题</th></tr></thead><tbody>{preview.quarantine.map((q,i)=><tr key={i}><td>{q.record}</td><td>{q.event??'整条'}</td><td>{q.reason}</td></tr>)}</tbody></table></div>}
   <details><summary>标准交易样例（最多30条）</summary><div className="retail-table-wrap"><table aria-label="标准交易样例"><thead><tr><th>事件</th><th>订单/行</th><th>SKU/规格</th><th>时间</th><th>金额（分）</th></tr></thead><tbody>{preview.sample.map((e,i)=><tr key={i}><td>{kinds[e.kind]}<small>{e.event_id}</small></td><td>{e.order_id}/{e.line_id}</td><td>{e.sku_id}/{e.spec}</td><td>{e.event_at}</td><td>{e.amount_minor}</td></tr>)}</tbody></table></div></details>
   {!view?.receipts.some(r=>r.previewId===preview.id)&&<>
    {preview.quarantinedRecords>0&&<div className="retail-ingest-form"><label className="retail-checkbox"><input type="checkbox" aria-label="允许部分入库" checked={partial} onChange={e=>setPartial(e.target.checked)}/>只入库有效事件，保留隔离记录并标记差异</label><label>部分入库原因（至少10字）<input aria-label="部分入库原因" value={reason} onChange={e=>setReason(e.target.value)}/></label></div>}
    <button className="retail-primary" disabled={busy||dirty||!preview.canConfirm||!!preview.quarantinedRecords&&(!partial||reason.trim().length<10)} onClick={()=>void send({op:'ingest_confirm',previewId:preview.id,reviewHash:preview.reviewHash,allowPartial:partial,reason})}>3. 确认入库</button>
   </>}
  </section>}
  {receipt&&<section aria-label="入库回执"><h3>入库回执</h3><p role="status">本次新增 {receipt.accepted} 条 · 已有重复 {receipt.duplicates} 条 · 隔离来源记录 {receipt.quarantinedRecords} 条</p><p>批次 {receipt.batchId} · 映射 v{receipt.mappingRevision} · {new Date(receipt.at).toLocaleString()}</p>
   <p>在「交易与退款」选择{receipt.source==='demo'?'演示':'CSV'}来源查看事件。{job.mode==='fixture'&&'演练日期为 2026-10-14 至 2026-10-16。'}</p>
   <button disabled={busy} onClick={()=>void send({op:'ingest_reconcile',receiptId:receipt.id})}>{job.mode==='fixture'?'4. 与独立演练控制总额对账':'4. 检查账本与对账状态'}</button>
   <details><summary>提供人工对账参考合计</summary><div className="retail-ingest-form"><p>请独立从后台核对本批事件集合。订单查询时间窗口不等于结算期；此处不验证后台身份或证明全店完整性。所有字段必填，未知不能填0。</p><label>参考数据观测时间（本机时区）<input aria-label="对账观测时间" type="datetime-local" value={statementObservedAt} onChange={e=>setStatementObservedAt(e.target.value)}/></label><label>对账来源名称<input aria-label="对账来源名称" value={statementLabel} onChange={e=>setStatementLabel(e.target.value)}/></label><label>对账店铺 ID<input aria-label="对账店铺 ID" value={statementShop} onChange={e=>setStatementShop(e.target.value)}/></label><div className="retail-ingest-columns">{Object.entries(totalLabels).map(([key,label])=><label key={key}>{label}<input aria-label={`对账 ${key}`} type="number" min={0} step={1} value={statementTotals[key as keyof ControlTotals]} onChange={e=>setStatementTotals(t=>({...t,[key]:e.target.value}))}/></label>)}</div><button disabled={busy} onClick={()=>void reconcileManual()}>按人工参考合计对账</button></div></details>
   <LineReferencePanel key={receipt.id} receiptId={receipt.id} busy={busy} send={send} result={reconciliation||undefined}/>
   {reconciliation&&<div aria-label="批次对账结果"><h3>{{matched:'合计一致',mismatch:'存在差异',unverified:'缺少独立参考，待核验'}[reconciliation.status]}</h3><p>依据：{{synthetic_control:'独立合成控制总额 · 非真实后台',operator_declared:'人工声明参考 · 未认证后台来源',operator_file:'人工参考文件 · 未认证后台来源',missing:'未提供参考合计'}[reconciliation.reference]}。账本不一致事件 {reconciliation.ledgerIssues} 条，隔离来源记录 {reconciliation.quarantinedRecords} 条。</p>{reconciliation.differences.length>0&&<div className="retail-table-wrap"><table aria-label="对账差异"><thead><tr><th>指标</th><th>参考</th><th>账本本批事件</th></tr></thead><tbody>{reconciliation.differences.map(d=><tr key={d.field}><td>{totalLabels[d.field as keyof ControlTotals]??d.field}</td><td>{d.expected}</td><td>{d.actual}</td></tr>)}</tbody></table></div>}</div>}
  </section>}
 </section>;
}
