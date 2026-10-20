import { useCallback, useEffect, useRef, useState } from 'react';
import type { ApprovalStatus, ApprovalView } from '../../../../../packages/retail-domain/src/approval-types';
import type { RetailRequest } from '../../../../../packages/retail-domain/src/operations';
import { DecisionValues } from './DecisionValues';
import {SourceMetadataSummary} from './SourceMetadata';
const labels:Record<ApprovalStatus,string>={pending:'待审批',approved:'模拟已批准',rejected:'已驳回',expired:'已过期',superseded:'已被新版本替代',invalidated:'证据或规则失效'};
const events:Record<string,string>={created:'保存草稿',revised:'保存新版本',submitted:'提交模拟审批',approval_approved:'批准模拟方案',approval_rejected:'驳回方案',approval_invalidated:'申请或批准失效'};
const actors:Record<string,string>={'local-analyst':'模拟分析员','local-simulation-approver':'模拟审批人','system-policy':'规则校验'};
export function ApprovalsPanel({initialRequestId,onBack,onExecution}:{initialRequestId:string|null;onBack:()=>void;onExecution:(requestId:string)=>void}) {
 const [items,setItems]=useState<ApprovalView[]>([]);const [focus,setFocus]=useState(initialRequestId??'');const [filter,setFilter]=useState<ApprovalStatus|'all'>(initialRequestId?'all':'pending');
 const [reason,setReason]=useState('');const [busy,setBusy]=useState(false);const [error,setError]=useState('');const [notice,setNotice]=useState('');const pending=useRef(false);const alive=useRef(true);
 useEffect(()=>{alive.current=true;return()=>{alive.current=false;};},[]);
 const call=useCallback(async(request:RetailRequest)=>{
  if(pending.current)return;pending.current=true;setBusy(true);setError('');setNotice('');
  try {const reply=await window.electronAPI.retailRequest(request);if(!reply.ok)throw new Error(reply.error);if(reply.kind!=='approvals')throw new Error('审批服务返回类型不符');if(!alive.current)return;
   setItems(reply.data);if(reply.selectedId)setFocus(reply.selectedId);if(request.op==='approval_resolve'){setFilter('all');setNotice(request.choice==='approve'?'模拟批准已记录，可查看待执行项；尚未写入模拟业务状态。':'驳回已记录。修订方案后需重新提交审批。');}
  }catch(e){if(alive.current){setError(e instanceof Error?e.message:'审批处理失败');if(request.op==='approval_resolve'){const refreshed=await window.electronAPI.retailRequest({op:'approvals'}).catch(()=>null);if(alive.current&&refreshed?.ok&&refreshed.kind==='approvals'){setItems(refreshed.data);setFilter('all');}}}}
  finally{pending.current=false;if(alive.current)setBusy(false);}
 },[]);
 useEffect(()=>{void call({op:'approvals'});},[call]);
 const filtered=items.filter(a=>filter==='all'||a.status===filter);const selected=filtered.find(a=>a.id===focus)??filtered[0];
 useEffect(()=>{setReason('');},[selected?.id]);
 const d=selected?.decision;const eligible=!!selected&&selected.status==='pending'&&!selected.blockers.length;
 const resolve=(choice:'approve'|'reject')=>{if(selected&&d)void call({op:'approval_resolve',requestId:selected.id,expectedVersion:d.version,expectedActionHash:d.actionHash,choice,reason});};
 return <section data-testid="retail-approvals"><div className="retail-section-title"><div><h2>审批中心</h2><p>本地单用户模拟审批。批准绑定当前方案版本，不代表真实业务授权，仅可另行执行到本地模拟账本。</p></div><button onClick={onBack}>返回决策草稿</button></div>
  {error&&<div className="retail-alert error" role="alert">{error}<button disabled={busy} onClick={()=>void call({op:'approvals'})}>刷新审批</button></div>}{notice&&<div className="retail-alert success" role="status">{notice}</div>}
  <div className="retail-inline-actions retail-approval-filters"><label>申请状态<select aria-label="审批状态筛选" value={filter} onChange={e=>setFilter(e.target.value as ApprovalStatus|'all')}><option value="all">全部状态</option>{Object.entries(labels).map(([key,label])=><option key={key} value={key}>{label}</option>)}</select></label><button disabled={busy} onClick={()=>void call({op:'approvals'})}>刷新审批</button><span className="retail-muted">待审批 {items.filter(a=>a.status==='pending').length} · 最近100条申请</span></div>
  <div className="retail-investigation-layout"><aside className="retail-investigation-list" aria-label="审批申请列表">{!filtered.length&&<p className="retail-muted">{busy?'正在读取申请…':filter==='pending'?'暂无待处理申请。可切换全部状态查看历史，或从决策草稿提交。':'当前筛选没有申请。'}</p>}{filtered.map(a=><button key={a.id} aria-current={a.id===selected?.id?'true':undefined} onClick={()=>setFocus(a.id)}><strong>{a.decision.scope.sku} · v{a.decision.version}</strong><span>{labels[a.status]}</span><small>{a.decision.selected.title}</small></button>)}</aside>
  <article className="retail-investigation-body">{selected&&d&&<><h2>{d.scope.sku} · v{d.version} · {labels[selected.status]}</h2><p>{d.scope.shop} / {d.scope.channel}{d.scope.campaign?` / ${d.scope.campaign}`:''}{d.scope.warehouse?` / ${d.scope.warehouse}`:''}。仅限本地模拟。</p>
   <h3>动作前后值</h3><DecisionValues before={d.before} after={d.after} label="审批前后值"/><p className="retail-muted">广告花费条件值参考历史花费，不是平台真实预算。执行时只写本地模拟状态。</p>
   <h3>来源、时效与复核</h3><p>来源：{d.scope.source==='demo'?'合成演示数据':'CSV'}；业务日期：{selected.evidence?.observedAt??d.scope.date}；导入时间：{selected.evidence?new Date(selected.evidence.importedAt).toLocaleString('zh-CN'):'无法核验'}。</p><p>Reviewer：{selected.evidence?.reviewer??'无法核验'}；有效至 {new Date(d.expiresAt).toLocaleString('zh-CN')}。批准不会延长原有效期。</p>
   <h3>选择理由、假设与约束</h3><p className="retail-approval-comment">{d.note||'未填写草稿备注'}</p><p>{d.selected.rationale}</p><ul>{[...d.selected.assumptions,...d.selected.constraints].map((text,i)=><li key={i}>{text}</li>)}</ul>
   <section aria-label="审批来源水位与风险"><SourceMetadataSummary provenance={selected.evidence?.timeContext?.sourceMetadata}/><h3>风险与补偿边界</h3><p>{d.scenario==='inventory'?'补货受理不等于实物到货；已受理请求不能通过补偿假装撤销。':d.scenario==='ads'?'预算条件测算不保证成交额或ROAS改善；归因窗口及流量变化会影响观察结果。':'价格或优惠变化不保证销量及毛利总额改善，需求响应尚未验证。'}</p><p>补偿不会自动执行，必须独立创建并重新审批。执行结果未知时先对账；若后续值或版本已变化、恢复后不满足约束，补偿会被拒绝，不能覆盖后续人工修改。</p></section>
   <h3>当前检查</h3>{selected.blockers.length?<ul className="retail-reasons">{selected.blockers.map((text,i)=><li key={i}>{text}</li>)}</ul>:<p>当前版本、证据及有效期检查通过。处理时会再次核验。</p>}
   {selected.resolution&&<section aria-label="审批结论"><h3>原审批结论</h3><p>{selected.resolution.decision==='approved'?'模拟批准':'驳回'} · {new Date(selected.resolution.resolvedAt).toLocaleString('zh-CN')} · 模拟审批人</p><p className="retail-approval-comment">{selected.resolution.reason}</p>{selected.status==='expired'||selected.status==='superseded'||selected.status==='invalidated'?<p>该历史结论已失效，不能作为后续执行依据。</p>:<p>仅记录审批结论，可在执行记录中核对本地模拟执行结果。</p>}</section>}
   {eligible&&<section aria-label="处理审批"><h3>处理此版本</h3><p className="retail-muted">当前角色：本机模拟审批人；未接入独立身份验证。</p><label className="retail-draft-field">审批理由<textarea aria-label="审批理由" maxLength={2000} rows={3} value={reason} disabled={busy} onChange={e=>setReason(e.target.value)} placeholder="说明批准或驳回此版本的依据"/></label><div className="retail-inline-actions"><button className="retail-primary" disabled={busy||!reason.trim()} onClick={()=>resolve('approve')}>批准模拟方案</button><button disabled={busy||!reason.trim()} onClick={()=>resolve('reject')}>驳回方案</button></div></section>}
   {selected.resolution?.decision==='approved'&&<button onClick={()=>onExecution(selected.id)}>查看模拟执行</button>}
   <details><summary>申请绑定与证据索引</summary><p>申请：{selected.id}；决策：{d.id}；版本：{d.version}；策略：{d.policyVersion}</p><p>动作摘要：{d.actionHash}</p><p>证据摘要：{d.evidenceHash}</p><p>调查：{d.investigationId}</p><ul>{d.evidenceIds.map(id=><li key={id}>{id}</li>)}</ul></details>
   <section aria-label="审批审计记录"><h3>审批审计</h3><ol className="retail-approval-audit">{selected.audit.map(event=><li key={event.id}><strong>{events[event.event]??event.event}</strong><span>{new Date(event.at).toLocaleString('zh-CN')} · {actors[event.actor]??event.actor}</span>{event.reason&&<p>{event.reason}</p>}</li>)}</ol></section>
  </>}</article></div>
 </section>;
}
