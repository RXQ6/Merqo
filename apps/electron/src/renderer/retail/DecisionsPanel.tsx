import {InvestigationCases} from './InvestigationCases';
import {TaskComposer} from './TaskComposer';
import {PageHeader} from './PageHeader';
import { useCallback, useEffect, useRef, useState } from 'react';
import type { AnyInvestigation, Scenario } from '../../../../../packages/retail-domain/src/investigations';
import type { DecisionDraft } from '../../../../../packages/retail-domain/src/decisions';
import type { RetailRequest } from '../../../../../packages/retail-domain/src/operations';
import { DecisionValues, draftStateLabels as states } from './DecisionValues';
export function DecisionsPanel({ target, onBack, onApproval, onInvestigation, onTask, initialId }: { onTask:(id:string)=>void;initialId?:string|null;target: AnyInvestigation | null; onBack: () => void; onApproval: (id:string) => void; onInvestigation: (id:string) => void }) {
  const [items,setItems]=useState<DecisionDraft[]>([]); const [focus,setFocus]=useState(target?'new':initialId??'');
  const [history,setHistory]=useState<DecisionDraft[]>([]); const [kind,setKind]=useState<Scenario['kind']>('observe'); const [note,setNote]=useState('');
  const [busy,setBusy]=useState(false); const [error,setError]=useState(''); const [notice,setNotice]=useState('');
  const pending=useRef(false); const alive=useRef(true);
  useEffect(()=>{alive.current=true;return()=>{alive.current=false;};},[]);
  const call=useCallback(async(request:RetailRequest)=>{
    if(pending.current)return;pending.current=true;setBusy(true);setError('');setNotice('');
    try { const reply=await window.electronAPI.retailRequest(request); if(!reply.ok)throw new Error(reply.error);if(reply.kind!=='decisions')throw new Error('决策服务返回类型不符');if(!alive.current)return;
      setItems(reply.data); if(reply.selectedId)setFocus(reply.selectedId); if(reply.history)setHistory(reply.history);
      if(request.op==='decision_submit')setNotice('已提交模拟审批，可到审批中心处理；当前不执行业务动作。');
      if(request.op==='decision_create'||request.op==='decision_revise')setNotice('草稿已保存，旧版本及申请保留在版本记录中。');
    }catch(e){if(alive.current)setError(e instanceof Error?e.message:'决策操作失败');}finally{pending.current=false;if(alive.current)setBusy(false);}
  },[]);
  useEffect(()=>{void call({op:'decisions'});},[call]);
  const selected=focus==='new'?items.find(d=>d.investigationId===target?.id):items.find(d=>d.id===focus)??(!target?items[0]:undefined);
  const [origin,setOrigin]=useState<AnyInvestigation|null>(null); const [originError,setOriginError]=useState('');
  const runId=selected?.investigationId??target?.id;
  useEffect(()=>{let active=true;setOrigin(null);setOriginError('');if(runId)void window.electronAPI.retailRequest({op:'investigations',id:runId}).then(reply=>{if(!active)return;if(!reply.ok)throw new Error(reply.error);if(reply.kind!=='investigations'||!reply.data[0])throw new Error('原调查读取失败');setOrigin(reply.data[0]);}).catch(()=>{if(active)setOriginError('原调查读取失败，请打开原调查重试。');});return()=>{active=false;};},[runId]);
  useEffect(()=>{if(selected){setKind(selected.selectedKind);setNote(selected.note);setHistory([]);}else if(target){setKind(target.report?.scenarios.find(s=>s.kind!=='observe')?.kind??'observe');setNote('');setHistory([]);}},[selected?.id,selected?.version,target?.id]);
  const dirty=!!selected&&(kind!==selected.selectedKind||note!==selected.note);
  const options=selected?.alternatives??target?.report?.scenarios??[];
  const save=()=>selected?void call({op:'decision_revise',id:selected.id,expectedVersion:selected.version,kind,note}):target?void call({op:'decision_create',investigationId:target.id,kind,note}):undefined;
  return <section data-testid="retail-decisions"><PageHeader title="决策草稿" actions={<><button onClick={onBack}>返回经营总览</button></>}>核对前后值、证据与约束，再提交模拟审批。当前不会修改经营数据。</PageHeader>
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
        <div className="retail-inline-actions"><button className="retail-primary" disabled={busy||!options.length} onClick={save}>{selected?'保存新版本':'保存草稿'}</button>{selected&&<><button disabled={busy||dirty||selected.state!=='draft'||!!selected.submissionBlockers.length} onClick={()=>void call({op:'decision_submit',id:selected.id,expectedVersion:selected.version})}>提交模拟审批</button><button disabled={busy} onClick={()=>void call({op:'decision_history',id:selected.id})}>查看版本记录</button><button disabled={busy} onClick={()=>onInvestigation(selected.investigationId)}>查看原调查与补证</button></>}</div>
      </>}
      {origin&&<InvestigationCases run={origin} onTask={onTask}/>}
      {selected&&<TaskComposer key={selected.id+':'+selected.version} origin={{kind:'decision',id:selected.id,version:selected.version}} title={selected.scope.sku+' '+selected.selected.title} simulationAllowed={selected.environment==='simulation'&&selected.selectedKind!=='observe'} onCreated={onTask}/>}
      {dirty&&<p role="status" className="retail-muted">有未保存修改，请先保存新版本再提交。</p>}
      {selected&&<><h3>已保存版本的前后值</h3><p className="retail-muted">表单修改须先保存新版本。广告花费条件值参考历史花费，不是平台当前预算。</p><DecisionValues before={selected.before} after={selected.after}/>
        <h3>影响范围与有效期</h3><p>仅 {selected.scope.shop} / {selected.scope.channel} / {selected.scope.sku}{selected.scope.campaign?` / ${selected.scope.campaign}`:''}{selected.scope.warehouse?` / ${selected.scope.warehouse}`:''}。{selected.environment==='simulation'?'只允许本地模拟审批。':'仅保存分析草稿，尚不能进入真实业务审批。'}</p><p>当前版本有效至 {new Date(selected.expiresAt).toLocaleString('zh-CN')}；提交时由服务重新检查。</p>
        <h3>假设与约束</h3><ul>{[...selected.selected.assumptions,...selected.selected.constraints].map((s,i)=><li key={i}>{s}</li>)}</ul>
        <h3>提交检查</h3>{selected.submissionBlockers.length?<ul className="retail-reasons">{selected.submissionBlockers.map((s,i)=><li key={i}>{s}</li>)}</ul>:<p>当前模拟提交检查通过；提交瞬间会再次校验版本、快照和时效。</p>}
        <section aria-label="草稿关联调查"><h3>关联调查与复核</h3>{origin?<><p>{origin.mode==='replay'?'离线规则演示（没有模型审核）':`模型调查 · ${origin.model??'未建立模型连接'}`} · {origin.report?({passed:'Reviewer 通过',needs_evidence:'Reviewer 待补证',rejected:'Reviewer 驳回'})[origin.report.reviewer.verdict]:origin.state==='failed'?'调查失败':origin.state==='running'?'调查进行中':'尚无复核结论'}</p>{origin.error&&<p role="alert">{origin.error}</p>}<ul>{origin.report?.reviewer.notes.map((s,i)=><li key={i}>{s}</li>)}</ul>{origin.mode==='replay'?<p>离线报告可用于分析和保存草稿；提交模拟审批前，需明确发起模型调查并通过 Reviewer。</p>:origin.report?.reviewer.verdict!=='passed'&&<p>请先处理报告中的未知项和复核意见；重试不会保证通过。</p>}</>:<p>{originError||'正在读取原调查…'}</p>}<p className="retail-muted">打开记录不会调用模型。重新调查产生独立报告；通过后请从新报告生成草稿，旧草稿不会自动更换调查或审批。</p></section>
        {selected.request&&<p role="status">申请 {selected.request.id} · 绑定 v{selected.request.decisionVersion} · {states[selected.state]}。当前不执行业务动作。<button className="retail-link" onClick={()=>onApproval(selected.request!.id)}>查看审批</button></p>}
        <details><summary>版本绑定与证据索引</summary><p>来源：{selected.scope.source}；调查：{selected.investigationId}；规则：{selected.ruleVersion}；策略：{selected.policyVersion}</p><p>动作摘要：{selected.actionHash}</p><p>证据摘要：{selected.evidenceHash}</p><ul>{selected.evidenceIds.map(id=><li key={id}>{id}</li>)}</ul></details>
        {!!history.length&&<section aria-label="决策版本记录"><h3>版本记录</h3>{history.map(d=><details key={d.version}><summary>v{d.version} · {states[d.state]} · {new Date(d.updatedAt).toLocaleString('zh-CN')}</summary><p>{d.selected.title}；备注：{d.note||'未填写'}</p><p>动作摘要：{d.actionHash}</p>{d.request&&<p>该版本申请：{d.request.id}（{d.request.status}）</p>}<pre>{JSON.stringify({before:d.before,after:d.after},null,2)}</pre></details>)}</section>}
      </>}
    </article></div>
  </section>;
}
