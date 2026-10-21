import {useRef,useState} from 'react';
import {WarehousePickInputSchema,type WarehousePickInput,type WarehousePickPlan,type WarehousePickReceipt} from '../../../../../packages/retail-domain/src/warehouse-contract';
import type {RetailRequest,RetailReply} from '../../../../../packages/retail-domain/src/operations';
const initial:WarehousePickInput={sourceId:'',shop:'',warehouse:'',sku:'',spec:'',quantity:1,orderRef:''};
const labels={ready:'建议可确认',insufficient:'可分配库存不足',needs_evidence:'缺少效期依据',blocked:'当前无法生成完整预占'};
export function WarehousePickingPanel({request,scope,onReserved}:{request:(r:RetailRequest)=>Promise<RetailReply|undefined>;scope:Pick<WarehousePickInput,'sourceId'|'shop'|'warehouse'>;onReserved:()=>Promise<void>}){
 const [input,setInput]=useState(initial),[plan,setPlan]=useState<WarehousePickPlan|null>(null),[receipt,setReceipt]=useState<WarehousePickReceipt|null>(null),[confirmed,setConfirmed]=useState(false),[busy,setBusy]=useState(false),[error,setError]=useState('');const pending=useRef(false);
 function edit(change:Partial<WarehousePickInput>){setInput(v=>({...v,...change}));setPlan(null);setReceipt(null);setConfirmed(false);setError('');}
 async function run(confirm:boolean){if(pending.current)return;const parsed=WarehousePickInputSchema.safeParse(input);if(!parsed.success){setError('请填写来源、店铺、仓库、SKU、规格、订单引用及正整数数量');return;}if(confirm&&(!plan||!confirmed))return;pending.current=true;setBusy(true);setError('');try{
  if(confirm&&plan){const r=await request({op:'warehouse_pick_confirm',id:plan.id,reviewHash:plan.hash});if(!r?.ok||r.kind!=='warehouse_pick_receipt')throw Error(r&&!r.ok?r.error:'预占确认失败');setReceipt(r.data);await onReserved();}
  else{setReceipt(null);setConfirmed(false);const r=await request({op:'warehouse_pick_preview',input:parsed.data});if(!r?.ok||r.kind!=='warehouse_pick_plan')throw Error(r&&!r.ok?r.error:'拣货建议生成失败');setPlan(r.data);}
 }catch(e){setError(e instanceof Error?e.message:'拣货操作失败');}finally{pending.current=false;setBusy(false);}}
 function download(){if(!plan)return;const url=URL.createObjectURL(new Blob([JSON.stringify({plan,receipt},null,2)],{type:'application/json'})),a=document.createElement('a');a.href=url;a.download='Merqo-按效期拣货与预占.json';a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);}
 return <section className="retail-picking" aria-label="按效期拣货与预占"><h3>按效期拣货与预占</h3><p className="retail-muted">按当前时刻选择先到期的有效批次，扣除已有预占；不跟随上方历史截止日期。确认后只生成本地预占，不发货、不改变现存或真实平台。</p>
  <div className="retail-inline-actions"><button disabled={busy} onClick={()=>edit({sourceId:scope.sourceId,shop:scope.shop,warehouse:scope.warehouse})}>使用上方仓库范围</button></div>
  <div className="retail-form-columns">{([['sourceId','拣货来源'],['shop','拣货店铺'],['warehouse','拣货仓库'],['sku','拣货SKU'],['spec','拣货规格'],['orderRef','预占订单引用']] as const).map(([key,label])=><label key={key}>{label}<input disabled={busy} aria-label={label} value={input[key]} maxLength={128} onChange={e=>edit({[key]:e.target.value})}/></label>)}<label>本次新增预占数量<input type="number" min={1} max={1000000} step={1} aria-label="本次新增预占数量" disabled={busy} value={input.quantity||''} onChange={e=>edit({quantity:Number(e.target.value)})}/></label></div>
  <div className="retail-action-bar"><button disabled={busy} onClick={()=>void run(false)}>生成按效期拣货建议</button></div>{error&&<p role="alert">{error}</p>}
  {plan&&<div aria-label="按效期拣货建议"><h3>{labels[plan.status]}</h3><p>业务日期 {plan.businessDay} · 已知可分配 {plan.knownAvailable} 件 · 本次需求 {plan.input.quantity} 件 · 缺口 {plan.shortfall} 件</p><p className="retail-muted">排除：效期未知 {plan.excluded.unknownExpiry} 件、过期 {plan.excluded.expired} 件、隔离/报废 {plan.excluded.quarantined} 件；已有预占 {plan.excluded.reserved} 件不参与分配。</p>{plan.reasons.map((s,i)=><p key={i}>{s}</p>)}
   <div className="retail-table-wrap"><table aria-label="按效期批次分配"><thead><tr><th>优先顺序</th><th>批次</th><th>效期</th><th>本次分配</th></tr></thead><tbody>{plan.selections.map((s,i)=><tr key={s.batchId}><td>{i+1}</td><td>{s.batchId}</td><td>{s.expiresOn}</td><td>{s.quantity}</td></tr>)}</tbody></table></div>
   <p className="retail-muted">有效至 {new Date(plan.validUntil).toLocaleTimeString()}；库存、来源证据或业务日期变化后须重新生成。缺量不自动部分预占，未知效期不参与全局先到期判断；订单引用为人工声明，不校验真实订单需求。</p>
   {plan.status==='ready'&&!receipt&&<><label className="retail-checkbox"><input type="checkbox" aria-label="确认按效期批次与新增预占" checked={confirmed} disabled={busy} onChange={e=>setConfirmed(e.target.checked)}/>已核对批次、数量和订单引用，确认本次新增预占</label><div className="retail-action-bar"><button className="retail-primary" disabled={busy||!confirmed} onClick={()=>void run(true)}>确认批次并生成预占</button></div></>}
   {receipt&&<p role="status">{receipt.replayed?'已有预占回执，本次没有重复扣占':'本地预占已生成'}：{receipt.reservationIds.length} 个批次，共 {receipt.plan.input.quantity} 件。现存数量不变。</p>}
   <div className="retail-action-bar"><button onClick={download}>导出拣货建议与预占回执</button></div>
  </div>}
 </section>;
}
