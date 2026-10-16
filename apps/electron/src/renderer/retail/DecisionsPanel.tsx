import { useCallback, useEffect, useRef, useState } from 'react';
import type { AnyInvestigation, Scenario } from '../../../../../packages/retail-domain/src/investigations';
import type { DecisionDraft } from '../../../../../packages/retail-domain/src/decisions';
import type { RetailRequest } from '../../../../../packages/retail-domain/src/operations';
const states = { draft: '草稿', pending_approval: '模拟待审批', superseded: '已被新版本替代', expired: '已过期' };
const labels: Record<string,string> = { couponMinor:'商家券 / 件', revenueMinor:'商品收入 / 件', marginBps:'毛利率', available:'即时可售', coverageDays:'覆盖天数', proposedQuantity:'补货草稿量', leadDays:'常规交期天数', spendMinor:'模拟花费条件值', hypotheticalRevenueMinor:'归因成交额条件值', roas:'效率不变 ROAS' };
const value = (key: string, number: number | null | undefined) => number === undefined ? '不适用' : number === null ? '待补证' : /Minor$/.test(key) ? `¥${(number/100).toFixed(2)}` : key==='marginBps' ? `${(number/100).toFixed(2)}%` : Number.isInteger(number) ? String(number) : number.toFixed(2);
export function DecisionsPanel({ target, onBack }: { target: AnyInvestigation | null; onBack: () => void }) {
  const [items,setItems]=useState<DecisionDraft[]>([]); const [focus,setFocus]=useState(target?'new':'');
  const [history,setHistory]=useState<DecisionDraft[]>([]); const [kind,setKind]=useState<Scenario['kind']>('observe'); const [note,setNote]=useState('');
  const [busy,setBusy]=useState(false); const [error,setError]=useState(''); const [notice,setNotice]=useState('');
  const pending=useRef(false); const alive=useRef(true);
  useEffect(()=>{alive.current=true;return()=>{alive.current=false;};},[]);
  const call=useCallback(async(request:RetailRequest)=>{
    if(pending.current)return;pending.current=true;setBusy(true);setError('');setNotice('');
    try { const reply=await window.electronAPI.retailRequest(request); if(!reply.ok)throw new Error(reply.error);if(reply.kind!=='decisions')throw new Error('决策服务返回类型不符');if(!alive.current)return;
      setItems(reply.data); if(reply.selectedId)setFocus(reply.selectedId); if(reply.history)setHistory(reply.history);
      if(request.op==='decision_submit')setNotice('已提交模拟审批；本轮尚未提供批准、驳回或业务执行。');
      if(request.op==='decision_create'||request.op==='decision_revise')setNotice('草稿已保存，旧版本及申请保留在版本记录中。');
    }catch(e){if(alive.current)setError(e instanceof Error?e.message:'决策操作失败');}finally{pending.current=false;if(alive.current)setBusy(false);}
  },[]);
  useEffect(()=>{void call({op:'decisions'});},[call]);
  const selected=focus==='new'?items.find(d=>d.investigationId===target?.id):items.find(d=>d.id===focus)??(!target?items[0]:undefined);
  useEffect(()=>{if(selected){setKind(selected.selectedKind);setNote(selected.note);setHistory([]);}else if(target){setKind(target.report?.scenarios.find(s=>s.kind!=='observe')?.kind??'observe');setNote('');setHistory([]);}},[selected?.id,selected?.version,target?.id]);
  const dirty=!!selected&&(kind!==selected.selectedKind||note!==selected.note);
  const options=selected?.alternatives??target?.report?.scenarios??[];
  const save=()=>selected?void call({op:'decision_revise',id:selected.id,expectedVersion:selected.version,kind,note}):target?void call({op:'decision_create',investigationId:target.id,kind,note}):undefined;
  return <section data-testid="retail-decisions"><div className="retail-section-title"><div><h2>决策草稿</h2><p>核对前后值、证据与约束，再提交模拟审批。当前不会修改经营数据。</p></div><button onClick={onBack}>返回经营总览</button></div>
    {error&&<div className="retail-alert error" role="alert">{error}<button disabled={busy} onClick={()=>void call({op:'decisions'})}>刷新草稿</button></div>}
    {notice&&<div className="retail-alert success" role="status">{notice}</div>}
    <div className="retail-investigation-layout"><aside className="retail-investigation-list" aria-label="决策草稿列表"><div className="retail-inline-actions"><strong>最近草稿</strong><button disabled={busy} onClick={()=>void call({op:'decisions'})}>刷新</button></div>
      {!items.length&&<p className="retail-muted">从调查报告点击“生成决策草稿”，将方案、证据与约束保存为版本。</p>}
      {target&&!selected&&<button aria-current="true">{target.evidence.row.sku_id} · 待保存</button>}
      {items.map(d=><button key={d.id} aria-current={d.id===selected?.id?'true':undefined} onClick={()=>setFocus(d.id)}><strong>{d.scope.sku} · v{d.version}</strong><span>{d.selected.title}</span><small>{states[d.state]} · {d.environment==='simulation'?'演示数据':'CSV分析'}</small></button>)}
    </aside><article className="retail-investigation-body">
      {(selected||target)&&<><h2>{selected?.scope.sku??target?.evidence.row.sku_id} · {selected?`v${selected.version} ${states[selected.state]}`:'新决策草稿'}</h2>
        <p className="retail-muted">{selected?`${selected.scope.shop} / ${selected.scope.channel} / ${selected.scope.date}`:`调查 ${target?.id}`}</p>
        <label className="retail-draft-field">选择条件方案<select aria-label="决策方案" disabled={busy} value={kind} onChange={e=>setKind(e.target.value as Scenario['kind'])}>{options.map(s=><option key={s.kind} value={s.kind}>{s.title}</option>)}</select></label>
        <label className="retail-draft-field">决策备注<textarea aria-label="决策备注" maxLength={2000} rows={3} value={note} disabled={busy} onChange={e=>setNote(e.target.value)} placeholder="记录选择理由、需要补充的证据或风险"/></label>
        <div className="retail-inline-actions"><button className="retail-primary" disabled={busy||!options.length} onClick={save}>{selected?'保存新版本':'保存草稿'}</button>{selected&&<><button disabled={busy||dirty||selected.state!=='draft'||!!selected.submissionBlockers.length} onClick={()=>void call({op:'decision_submit',id:selected.id,expectedVersion:selected.version})}>提交模拟审批</button><button disabled={busy} onClick={()=>void call({op:'decision_history',id:selected.id})}>查看版本记录</button></>}</div>
      </>}
      {dirty&&<p role="status" className="retail-muted">有未保存修改，请先保存新版本再提交。</p>}
      {selected&&<><h3>已保存版本的前后值</h3><p className="retail-muted">表单修改须先保存新版本。广告花费条件值参考历史花费，不是平台当前预算。</p><div className="retail-table-wrap"><table aria-label="决策前后值"><thead><tr><th>指标</th><th>原值</th><th>方案条件值</th></tr></thead><tbody>{[...new Set([...Object.keys(selected.before),...Object.keys(selected.after)])].map(key=><tr key={key}><td>{labels[key]??key}</td><td>{value(key,selected.before[key])}</td><td>{value(key,selected.after[key])}</td></tr>)}</tbody></table></div>
        <h3>影响范围与有效期</h3><p>仅 {selected.scope.shop} / {selected.scope.channel} / {selected.scope.sku}{selected.scope.campaign?` / ${selected.scope.campaign}`:''}{selected.scope.warehouse?` / ${selected.scope.warehouse}`:''}。{selected.environment==='simulation'?'只允许本地模拟审批。':'仅保存分析草稿，尚不能进入真实业务审批。'}</p><p>当前版本有效至 {new Date(selected.expiresAt).toLocaleString('zh-CN')}；提交时由服务重新检查。</p>
        <h3>假设与约束</h3><ul>{[...selected.selected.assumptions,...selected.selected.constraints].map((s,i)=><li key={i}>{s}</li>)}</ul>
        <h3>提交检查</h3>{selected.submissionBlockers.length?<ul className="retail-reasons">{selected.submissionBlockers.map((s,i)=><li key={i}>{s}</li>)}</ul>:<p>当前模拟提交检查通过；提交瞬间会再次校验版本、快照和时效。</p>}
        {selected.request&&<p role="status">申请 {selected.request.id} · 绑定 v{selected.request.decisionVersion} · {states[selected.state]}。审批处理与执行尚未接入。</p>}
        <details><summary>版本绑定与证据索引</summary><p>来源：{selected.scope.source}；调查：{selected.investigationId}；规则：{selected.ruleVersion}；策略：{selected.policyVersion}</p><p>动作摘要：{selected.actionHash}</p><p>证据摘要：{selected.evidenceHash}</p><ul>{selected.evidenceIds.map(id=><li key={id}>{id}</li>)}</ul></details>
        {!!history.length&&<section aria-label="决策版本记录"><h3>版本记录</h3>{history.map(d=><details key={d.version}><summary>v{d.version} · {states[d.state]} · {new Date(d.updatedAt).toLocaleString('zh-CN')}</summary><p>{d.selected.title}；备注：{d.note||'未填写'}</p><p>动作摘要：{d.actionHash}</p>{d.request&&<p>该版本申请：{d.request.id}（{d.request.status}）</p>}<pre>{JSON.stringify({before:d.before,after:d.after},null,2)}</pre></details>)}</section>}
      </>}
    </article></div>
  </section>;
}
